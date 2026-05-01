// Copyright (c) 2026 OPEN CASCADE SAS
//
// Worker-first workflow orchestrator for browser-side CAD ingestion pipelines.
// STEP/IGES/mesh formats are processed in isolated wasm workers and written
// back as XBF for the viewer. BRep/XBF stay local-inline.
//
// Architecture:
//   - EventEmitter for decoupled UI updates (job:created, job:progress, etc.)
//   - Formal backend interface: probe(), execute(job, ctx), cancel(job)
//   - Configurable concurrency per-type with worker pool idle management
//   - Job cancellation via worker.terminate()
//   - Worker progress streaming via postMessage
//   - Async remote backend with submit/poll/download pattern
//   - Worker manifest discovery from workers-manifest.json
(function(global) {
  'use strict';

  // ── Constants & Enums ─────────────────────────────────────────────────────

  var STATUS = {
    Pending: 'pending',
    Assigned: 'assigned',
    Running: 'running',
    Done: 'done',
    Failed: 'failed',
    Timeout: 'timeout',
    Retrying: 'retrying',
    Cancelled: 'cancelled'
  };

  var TYPE = {
    BrowserImport: 'browser-import',
    StepImport: 'step-import',
    IgesImport: 'iges-import',
    BRepImport: 'brep-import',
    XbfImport: 'xbf-import',
    MeshImport: 'mesh-import',
    Meshing: 'meshing',
    UnknownImport: 'unknown-import'
  };

  var WORKFLOW_ROOT = '/cs_workflow';
  var STAGING_ROOT = '/cs_staging';
  var JOBS_STATE_FILE = WORKFLOW_ROOT + '/jobs.json';
  var JOBS_STATE_TMP_FILE = WORKFLOW_ROOT + '/jobs.json.tmp';
  var HEARTBEAT_FILE_NAME = 'heartbeat';
  var STATUS_FILE_NAME = 'status.json';
  var HEARTBEAT_TIMEOUT_MS = 30000;
  var HEARTBEAT_INTERVAL_MS = 5000;
  var DEFAULT_MAX_RETRIES = 1;
  var ENABLE_ISOLATED_IMPORT_WORKERS = true;

  // ── Concurrency configuration ─────────────────────────────────────────────
  //
  // Each isolated WASM worker carries its own ~hundreds-of-MB heap and runs on
  // its own OS thread. We auto-size based on detected hardware concurrency,
  // leaving one core for the UI/main thread. Capped at 8 to bound memory in
  // webview hosts. Hosts can override at runtime via setConcurrency().
  //
  // This is the primary parallelism mechanism in single-threaded WASM mode
  // (CASCADESCOPE_WASM_PTHREADS=OFF) — no SharedArrayBuffer required.

  function detectConcurrencyDefaults() {
    var hw = (typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number')
      ? navigator.hardwareConcurrency
      : 4;
    var total = Math.max(2, Math.min(8, hw - 1));
    return {
      maxTotal: total,
      maxPerType: Math.max(1, Math.floor(total / 2)),
      idleTerminateMs: 60000
    };
  }

  var concurrencyConfig = detectConcurrencyDefaults();

  // ── State ─────────────────────────────────────────────────────────────────

  var moduleRef = null;
  var backends = Object.create(null);
  var pendingQueue = [];
  var runningJobs = new Map();
  var allJobs = new Map();
  var browserRequests = new Map();
  var monitorTimerId = null;
  var persistTimerId = null;
  var isPersistDirty = false;
  var isAttached = false;
  var workerAssetChecks = Object.create(null);
  var workerManifest = null;
  var activeWorkers = new Map();
  var backendPriorities = Object.create(null);
  var backendAvailability = Object.create(null);
  var isProbing = false;

  var remoteBackendConfig = {
    enabled: false,
    baseUrl: '',
    authToken: '',
    endpoint: '/api/jobs',
    pollIntervalMs: 2000,
    pollTimeoutMs: 300000
  };

  // ── EventEmitter ──────────────────────────────────────────────────────────

  var eventListeners = Object.create(null);

  function on(eventName, callback) {
    if (typeof callback !== 'function') {
      return;
    }
    if (!eventListeners[eventName]) {
      eventListeners[eventName] = [];
    }
    eventListeners[eventName].push(callback);
  }

  function off(eventName, callback) {
    if (!eventListeners[eventName]) {
      return;
    }
    if (!callback) {
      delete eventListeners[eventName];
      return;
    }
    eventListeners[eventName] = eventListeners[eventName].filter(function(fn) {
      return fn !== callback;
    });
  }

  function emit(eventName) {
    var listeners = eventListeners[eventName];
    if (!listeners || listeners.length === 0) {
      return;
    }
    var args = Array.prototype.slice.call(arguments, 1);
    for (var i = 0; i < listeners.length; ++i) {
      try {
        listeners[i].apply(null, args);
      } catch (err) {
        console.warn('CascadeScopeWorkflow: event handler error for ' + eventName, err);
      }
    }
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  function nowMs() {
    return Date.now();
  }

  function randomSuffix() {
    return Math.random().toString(36).slice(2, 10);
  }

  function makeJobId() {
    return 'job-' + nowMs().toString() + '-' + randomSuffix();
  }

  function makeRequestId() {
    return 'request-' + nowMs().toString() + '-' + randomSuffix();
  }

  function ensureFsReady() {
    return !!(moduleRef && moduleRef.FS);
  }

  function ensurePath(path) {
    if (!ensureFsReady()) {
      return false;
    }
    try {
      moduleRef.FS.mkdirTree(path);
    } catch (err) {
      if (!(err && err.code === 'EEXIST')) {
        console.warn('CascadeScopeWorkflow: mkdirTree failed for ' + path, err);
        return false;
      }
    }
    return true;
  }

  function normalizeFileName(fileName) {
    if (!fileName) {
      return 'unnamed';
    }
    return String(fileName).replace(/[\\\/]/g, '_');
  }

  function lowerExtension(fileName) {
    var cleanName = normalizeFileName(fileName);
    var dot = cleanName.lastIndexOf('.');
    if (dot < 0 || dot + 1 >= cleanName.length) {
      return '';
    }
    return cleanName.substring(dot + 1).toLowerCase();
  }

  function detectImportType(fileName) {
    var ext = lowerExtension(fileName);
    if (ext === 'step' || ext === 'stp') {
      return TYPE.StepImport;
    }
    if (ext === 'iges' || ext === 'igs') {
      return TYPE.IgesImport;
    }
    if (ext === 'brep') {
      return TYPE.BRepImport;
    }
    if (ext === 'xbf') {
      return TYPE.XbfImport;
    }
    if (ext === 'stl' || ext === 'obj' || ext === 'ply' || ext === 'wrl') {
      return TYPE.MeshImport;
    }
    return TYPE.UnknownImport;
  }

  function detectBatchType(files) {
    if (!files || files.length === 0) {
      return TYPE.BrowserImport;
    }
    var firstType = detectImportType(files[0].name);
    for (var i = 1; i < files.length; ++i) {
      if (detectImportType(files[i].name) !== firstType) {
        return TYPE.BrowserImport;
      }
    }
    return firstType;
  }

  // ── Backend priority & selection ──────────────────────────────────────────

  var defaultBackendPriorities = {};
  defaultBackendPriorities[TYPE.StepImport] = ['remote-http', 'worker-step', 'local-inline'];
  defaultBackendPriorities[TYPE.IgesImport] = ['remote-http', 'worker-iges', 'local-inline'];
  defaultBackendPriorities[TYPE.MeshImport] = ['remote-http', 'worker-mesh', 'local-inline'];
  defaultBackendPriorities[TYPE.Meshing] = ['remote-http', 'worker-mesher', 'local-inline'];

  function chooseBackendForType(type, preferredBackend) {
    if (preferredBackend) {
      return preferredBackend;
    }
    var priorities = backendPriorities[type] || defaultBackendPriorities[type];
    if (priorities) {
      for (var i = 0; i < priorities.length; ++i) {
        var name = priorities[i];
        var backend = backends[name];
        if (!backend) {
          continue;
        }
        if (name === 'remote-http' && !(remoteBackendConfig.enabled && remoteBackendConfig.baseUrl)) {
          continue;
        }
        if (name.indexOf('worker-') === 0 && !ENABLE_ISOLATED_IMPORT_WORKERS) {
          continue;
        }
        // Skip backends known to be unavailable from probing
        if (backendAvailability[name] === false) {
          continue;
        }
        return name;
      }
    }
    return 'local-inline';
  }

  function configureBackendPriority(priorityMap) {
    if (!priorityMap) {
      return;
    }
    var keys = Object.keys(priorityMap);
    for (var i = 0; i < keys.length; ++i) {
      var key = keys[i];
      if (Array.isArray(priorityMap[key])) {
        backendPriorities[key] = priorityMap[key].slice();
      }
    }
  }

  // ── File I/O helpers ──────────────────────────────────────────────────────

  function readFileAsUint8Array(file) {
    return new Promise(function(resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function() {
        reject(new Error('FileReader failed for ' + file.name));
      };
      reader.onload = function(ev) {
        resolve(new Uint8Array(ev.target.result));
      };
      reader.readAsArrayBuffer(file);
    });
  }

  function writeUtf8(path, text) {
    moduleRef.FS.writeFile(path, text, { encoding: 'utf8' });
  }

  function writeBinary(path, bytes) {
    moduleRef.FS.writeFile(path, bytes);
  }

  function readUtf8(path) {
    return moduleRef.FS.readFile(path, { encoding: 'utf8' });
  }

  function toBase64(bytes) {
    var chunkSize = 0x8000;
    var binary = '';
    for (var i = 0; i < bytes.length; i += chunkSize) {
      var chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  function fromBase64(text) {
    var binary = atob(text);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; ++i) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  function writeJsonAtomic(path, tempPath, value) {
    var payload = JSON.stringify(value, null, 2);
    try {
      moduleRef.FS.unlink(tempPath);
    } catch (err) {
      if (!(err && err.code === 'ENOENT')) {
        console.warn('CascadeScopeWorkflow: failed to clear temporary file', err);
      }
    }
    writeUtf8(tempPath, payload);
    try {
      moduleRef.FS.rename(tempPath, path);
    } catch (err) {
      console.warn('CascadeScopeWorkflow: rename failed, writing directly', err);
      writeUtf8(path, payload);
    }
  }

  function schedulePersist() {
    isPersistDirty = true;
    if (!ensureFsReady()) {
      return;
    }
    if (persistTimerId !== null) {
      return;
    }
    persistTimerId = setTimeout(function() {
      persistTimerId = null;
      flushPersist();
    }, 200);
  }

  function flushPersist() {
    if (!isPersistDirty || !ensureFsReady()) {
      return;
    }
    isPersistDirty = false;
    if (!ensurePath(WORKFLOW_ROOT)) {
      return;
    }
    var jobs = [];
    allJobs.forEach(function(job) {
      jobs.push(exportJob(job));
    });
    jobs.sort(function(a, b) {
      return a.createdAt - b.createdAt;
    });
    writeJsonAtomic(JOBS_STATE_FILE, JOBS_STATE_TMP_FILE, {
      version: 1,
      updatedAt: nowMs(),
      jobs: jobs
    });

    if (typeof moduleRef.syncfsPersist === 'function') {
      moduleRef.syncfsPersist(function(err) {
        if (err) {
          console.warn('CascadeScopeWorkflow: syncfsPersist failed', err);
        }
      });
    } else if (moduleRef.FS && typeof moduleRef.FS.syncfs === 'function') {
      moduleRef.FS.syncfs(false, function(err) {
        if (err) {
          console.warn('CascadeScopeWorkflow: FS.syncfs(false) failed', err);
        }
      });
    }
  }

  // ── Job data model ────────────────────────────────────────────────────────

  function exportJob(job) {
    return {
      id: job.id,
      type: job.type,
      backend: job.backend,
      status: job.status,
      createdAt: job.createdAt,
      assignedAt: job.assignedAt || null,
      startedAt: job.startedAt || null,
      completedAt: job.completedAt || null,
      lastHeartbeat: job.lastHeartbeat || null,
      retryCount: job.retryCount,
      maxRetries: job.maxRetries,
      progress: job.progress,
      progressMessage: job.progressMessage || '',
      errorMessage: job.errorMessage || '',
      requestId: job.requestId || '',
      dropZone: job.dropZone,
      callbackName: job.callbackName,
      inputFiles: job.inputFiles.slice(),
      outputFiles: job.outputFiles.slice()
    };
  }

  // ── Staging filesystem ────────────────────────────────────────────────────

  function stagingJobDir(job) {
    return STAGING_ROOT + '/jobs/' + job.id;
  }

  function stagingInputDir(job) {
    return stagingJobDir(job) + '/input';
  }

  function stagingOutputDir(job) {
    return stagingJobDir(job) + '/output';
  }

  function statusFilePath(job) {
    return stagingJobDir(job) + '/' + STATUS_FILE_NAME;
  }

  function heartbeatFilePath(job) {
    return stagingJobDir(job) + '/' + HEARTBEAT_FILE_NAME;
  }

  function ensureJobDirectories(job) {
    return ensurePath(stagingInputDir(job))
        && ensurePath(stagingOutputDir(job));
  }

  function writeJobStatusFile(job) {
    if (!ensureFsReady()) {
      return;
    }
    if (!ensureJobDirectories(job)) {
      return;
    }
    writeJsonAtomic(statusFilePath(job), statusFilePath(job) + '.tmp', exportJob(job));
  }

  function writeHeartbeat(job) {
    if (!ensureFsReady()) {
      return;
    }
    job.lastHeartbeat = nowMs();
    writeUtf8(heartbeatFilePath(job), String(job.lastHeartbeat));
    writeJobStatusFile(job);
    schedulePersist();
  }

  // ── Job state transitions (with events) ───────────────────────────────────

  function setStatus(job, status, message) {
    var prevStatus = job.status;
    job.status = status;
    if (typeof message === 'string' && message.length > 0) {
      job.progressMessage = message;
    }
    var timestamp = nowMs();
    if (status === STATUS.Assigned) {
      job.assignedAt = timestamp;
    }
    if (status === STATUS.Running) {
      job.startedAt = timestamp;
      job.lastHeartbeat = timestamp;
    }
    if (status === STATUS.Done || status === STATUS.Failed || status === STATUS.Timeout || status === STATUS.Cancelled) {
      job.completedAt = timestamp;
    }
    writeJobStatusFile(job);
    schedulePersist();

    // Emit events for state transitions
    emit('job:status', exportJob(job), prevStatus);
    if (status === STATUS.Done) {
      emit('job:done', exportJob(job));
    } else if (status === STATUS.Failed) {
      emit('job:failed', exportJob(job), job.errorMessage);
    } else if (status === STATUS.Cancelled) {
      emit('job:cancelled', exportJob(job));
    } else if (status === STATUS.Timeout) {
      emit('job:timeout', exportJob(job));
    }
  }

  function updateProgress(job, progress, message) {
    if (typeof progress === 'number') {
      job.progress = Math.max(0, Math.min(100, progress));
    }
    if (typeof message === 'string') {
      job.progressMessage = message;
    }
    writeHeartbeat(job);
    emit('job:progress', exportJob(job), job.progress, job.progressMessage);
  }

  // ── C++ callback bridge ───────────────────────────────────────────────────

  function callbackPathForJobFile(job, fileIndex, fileName) {
    return '/tmp/' + job.id + '_' + String(fileIndex) + '_' + normalizeFileName(fileName);
  }

  function stagedPathForJobFile(baseDir, fileIndex, fileName) {
    return baseDir + '/' + String(fileIndex) + '_' + normalizeFileName(fileName);
  }

  function requestManifestPath(request) {
    return WORKFLOW_ROOT + '/requests/' + request.id + '.txt';
  }

  function ensureRequestDirectories() {
    return ensurePath(WORKFLOW_ROOT) && ensurePath(WORKFLOW_ROOT + '/requests');
  }

  function invokeCppCallback(job, path, hasSupportedFiles) {
    if (!moduleRef || typeof moduleRef.ccall !== 'function') {
      throw new Error('ccall runtime method is unavailable');
    }
    if (job.callbackName === 'CascadeScope_WasmFileDropped') {
      moduleRef.ccall(job.callbackName,
                      null,
                      ['string', 'number', 'number'],
                      [path, job.dropZone, hasSupportedFiles ? 1 : 0]);
    } else {
      moduleRef.ccall(job.callbackName, null, ['string'], [path]);
    }
  }

  function invokeCppBatchCallback(request, orderedPaths) {
    if (!moduleRef || typeof moduleRef.ccall !== 'function') {
      throw new Error('ccall runtime method is unavailable');
    }
    if (!ensureRequestDirectories()) {
      throw new Error('Failed to create request directory for callback manifest');
    }
    var manifestPath = requestManifestPath(request);
    writeUtf8(manifestPath, orderedPaths.join('\n'));
    if (request.callbackName === 'CascadeScope_WasmFileDropped') {
      moduleRef.ccall('CascadeScope_WasmFilesDropped',
                      null,
                      ['string', 'number', 'number'],
                      [manifestPath, request.dropZone, orderedPaths.length > 0 ? 1 : 0]);
    } else {
      moduleRef.ccall('CascadeScope_WasmFilesUploaded', null, ['string'], [manifestPath]);
    }
  }

  function recordBrowserRequestOutputs(job, callbackTargets) {
    if (!job.requestId) {
      return;
    }
    var request = browserRequests.get(job.requestId);
    if (!request) {
      return;
    }
    for (var i = 0; i < callbackTargets.length; ++i) {
      var orderIndex = job.requestOrderIndices && job.requestOrderIndices.length > i
        ? job.requestOrderIndices[i]
        : i;
      request.callbackTargets[orderIndex] = callbackTargets[i];
    }
  }

  function flushBrowserRequestIfReady(requestId) {
    var request = browserRequests.get(requestId);
    if (!request || request.isDispatched) {
      return;
    }
    if ((request.completedJobs + request.failedJobs) < request.totalJobs) {
      return;
    }
    request.isDispatched = true;
    var orderedPaths = [];
    for (var i = 0; i < request.callbackTargets.length; ++i) {
      if (request.callbackTargets[i]) {
        orderedPaths.push(request.callbackTargets[i]);
      }
    }
    try {
      if (orderedPaths.length > 0) {
        invokeCppBatchCallback(request, orderedPaths);
      }
    } finally {
      browserRequests.delete(requestId);
    }
  }

  function finishBrowserRequestJob(job, isSuccess) {
    if (!job.requestId || job.requestIsFinalized) {
      return;
    }
    job.requestIsFinalized = true;
    var request = browserRequests.get(job.requestId);
    if (!request) {
      return;
    }
    if (isSuccess) {
      request.completedJobs += 1;
    } else {
      request.failedJobs += 1;
    }
    flushBrowserRequestIfReady(job.requestId);
  }

  function copyToLegacyTmpPath(sourcePath, fileName, job, fileIndex) {
    var targetPath = callbackPathForJobFile(job, fileIndex, fileName);
    var payload = moduleRef.FS.readFile(sourcePath);
    try {
      moduleRef.FS.unlink(targetPath);
    } catch (err) {
      if (!(err && err.code === 'ENOENT')) {
        console.warn('CascadeScopeWorkflow: failed to remove previous tmp file ' + targetPath, err);
      }
    }
    moduleRef.FS.writeFile(targetPath, payload);
    return targetPath;
  }

  function xbfNameForSource(fileName) {
    var base = normalizeFileName(fileName);
    var dot = base.lastIndexOf('.');
    if (dot > 0) {
      base = base.substring(0, dot);
    }
    return base + '.xbf';
  }

  // ── Worker bootstrap & IPC ────────────────────────────────────────────────
  // The bootstrap runs inside a blob: Worker. It supports two modes:
  // 1. One-shot (type: 'run') — legacy single-use worker
  // 2. Pooled  (type: 'init' then 'run') — reusable worker
  // In pooled mode the Worker thread stays alive between jobs. Only the
  // Emscripten module is re-instantiated (fast due to browser WASM cache).
  // Progress streaming: C++ workers print "PROGRESS:pct:message" to stdout,
  // parsed by the bootstrap and relayed via postMessage.

  function workerBootstrapScript() {
    return [
      "var _factory = null;",
      "var _baseUrl = null;",
      "var _exportName = null;",
      "",
      "async function runJob(msg) {",
      "  if (!_factory) {",
      "    importScripts(msg.scriptUrl);",
      "    _exportName = msg.exportName;",
      "    _factory = self[_exportName];",
      "    _baseUrl = new URL(msg.scriptUrl, self.location.href);",
      "    if (typeof _factory !== 'function') { throw new Error('Missing worker export: ' + _exportName); }",
      "  }",
      "  var mod = await _factory({",
      "    noInitialRun: true,",
      "    mainScriptUrlOrBlob: msg.scriptUrl,",
      "    locateFile: function(path) {",
      "      return new URL(path, _baseUrl).href;",
      "    },",
      "    print: function(text) {",
      "      if (typeof text === 'string' && text.indexOf('PROGRESS:') === 0) {",
      "        var parts = text.substring(9).split(':');",
      "        var pct = parseInt(parts[0], 10);",
      "        var pmsg = parts.slice(1).join(':');",
      "        self.postMessage({ type: 'progress', progress: pct, message: pmsg });",
      "      }",
      "    },",
      "    printErr: function(){}",
      "  });",
      "  self.postMessage({ type: 'progress', progress: 5, message: 'WASM module loaded' });",
      "  mod.FS.writeFile(msg.inputPath, new Uint8Array(msg.inputBytes));",
      "  var commandFile = '/tmp/cascadescope_worker_command.txt';",
      "  var commandPayload = [",
      "    'jobId=' + (msg.jobId || ''),",
      "    'jobType=' + (msg.jobType || ''),",
      "    'input=' + (msg.inputPath || ''),",
      "    'output=' + (msg.outputPath || ''),",
      "    'payload=' + (msg.payload || '')",
      "  ].join('\\n');",
      "  mod.FS.writeFile(commandFile, commandPayload, { encoding: 'utf8' });",
      "  self.postMessage({ type: 'progress', progress: 10, message: 'Starting conversion' });",
      "  var exitCode = 0;",
      "  try {",
      "    if (typeof mod._main !== 'function') {",
      "      throw new Error('No callable worker entrypoint (_main)');",
      "    }",
      "    var aMainResult = mod._main(0, 0);",
      "    exitCode = (typeof aMainResult === 'number') ? aMainResult : 0;",
      "  }",
      "  catch (err) { if (typeof err === 'number') { exitCode = err; } else { throw err; } }",
      "  if (exitCode !== 0) { throw new Error('Worker main exited with code ' + exitCode); }",
      "  self.postMessage({ type: 'progress', progress: 95, message: 'Reading output' });",
      "  var out = mod.FS.readFile(msg.outputPath);",
      "  return out;",
      "}",
      "",
      "self.onmessage = async function(e) {",
      "  var msg = e.data || {};",
      "  if (msg.type === 'terminate') {",
      "    self.close();",
      "    return;",
      "  }",
      "  try {",
      "    var out = await runJob(msg);",
      "    self.postMessage({ type: 'done', ok: true, outputBytes: out.buffer }, [out.buffer]);",
      "  } catch (err) {",
      "    var txt = (err && err.message) ? err.message : String(err);",
      "    self.postMessage({ type: 'error', ok: false, error: txt });",
      "  }",
      "};"
    ].join("\n");
  }

  // ── Worker pool ───────────────────────────────────────────────────────────
  // Keeps warm workers alive for reuse. Workers are keyed by script name.
  // Idle workers are terminated after concurrencyConfig.idleTerminateMs.

  var workerPool = Object.create(null);
  var poolBlobUrl = null;

  function getPoolBlobUrl() {
    if (!poolBlobUrl) {
      poolBlobUrl = URL.createObjectURL(new Blob([workerBootstrapScript()], { type: 'text/javascript' }));
    }
    return poolBlobUrl;
  }

  function acquirePooledWorker(scriptName) {
    var pool = workerPool[scriptName];
    if (pool && pool.worker && !pool.busy) {
      if (pool.idleTimer) {
        clearTimeout(pool.idleTimer);
        pool.idleTimer = null;
      }
      pool.busy = true;
      pool.useCount += 1;
      return pool;
    }
    // Create new pooled worker
    var blobUrl = getPoolBlobUrl();
    var worker = new Worker(blobUrl);
    var entry = {
      worker: worker,
      scriptName: scriptName,
      busy: true,
      useCount: 1,
      idleTimer: null,
      createdAt: nowMs()
    };
    workerPool[scriptName] = entry;
    return entry;
  }

  function releasePooledWorker(scriptName) {
    var pool = workerPool[scriptName];
    if (!pool) {
      return;
    }
    pool.busy = false;
    // Schedule idle termination
    pool.idleTimer = setTimeout(function() {
      if (pool && !pool.busy) {
        pool.worker.postMessage({ type: 'terminate' });
        pool.worker.terminate();
        delete workerPool[scriptName];
        emit('worker:pool-evicted', { script: scriptName, useCount: pool.useCount });
      }
    }, concurrencyConfig.idleTerminateMs);
  }

  function terminateAllPooledWorkers() {
    var keys = Object.keys(workerPool);
    for (var i = 0; i < keys.length; ++i) {
      var pool = workerPool[keys[i]];
      if (pool) {
        if (pool.idleTimer) {
          clearTimeout(pool.idleTimer);
        }
        pool.worker.terminate();
      }
    }
    workerPool = Object.create(null);
  }

  function resolveWorkerScriptUrl(workerScriptName) {
    if (!workerScriptName) {
      throw new Error('Worker script name is empty');
    }
    function absolutize(urlLike) {
      if (!urlLike) {
        return '';
      }
      if (typeof urlLike === 'string'
       && (urlLike.indexOf('http://') === 0
        || urlLike.indexOf('https://') === 0
        || urlLike.indexOf('blob:') === 0
        || urlLike.indexOf('data:') === 0
        || urlLike.indexOf('/') === 0)) {
        return new URL(urlLike, global.location.href).href;
      }
      return new URL(String(urlLike), global.location.href).href;
    }
    if (moduleRef && typeof moduleRef.locateFile === 'function') {
      var located = moduleRef.locateFile(workerScriptName, '');
      if (located && typeof located === 'string') {
        return absolutize(located);
      }
    }
    return absolutize(workerScriptName);
  }

  async function ensureWorkerScriptAvailable(workerScriptName) {
    var scriptUrl = resolveWorkerScriptUrl(workerScriptName);
    if (workerAssetChecks[scriptUrl]) {
      return workerAssetChecks[scriptUrl];
    }
    workerAssetChecks[scriptUrl] = fetch(scriptUrl, { method: 'HEAD', cache: 'no-store' })
      .then(function(response) {
        if (response.ok) {
          return scriptUrl;
        }
        if (response.status === 405 || response.status === 501) {
          return fetch(scriptUrl, { method: 'GET', cache: 'no-store' }).then(function(getResp) {
            if (!getResp.ok) {
              throw new Error('Worker script fetch failed (' + getResp.status + '): ' + scriptUrl);
            }
            return scriptUrl;
          });
        }
        throw new Error('Worker script check failed (' + response.status + '): ' + scriptUrl);
      })
      .catch(function(err) {
        delete workerAssetChecks[scriptUrl];
        throw err;
      });
    return workerAssetChecks[scriptUrl];
  }

  // Runs a single file through an isolated WASM worker with progress streaming.
  // Uses the worker pool for reuse when possible.
  async function runIsolatedWasmConvert(workerScriptName, exportName, job, browserFile, inputBytes, payloadText) {
    var scriptUrl = await ensureWorkerScriptAvailable(workerScriptName);
    var inputExt = lowerExtension(browserFile.name);
    var inputPath = '/tmp/input.' + (inputExt || 'cad');
    var outputPath = '/tmp/output.xbf';
    var poolEntry = acquirePooledWorker(workerScriptName);
    var worker = poolEntry.worker;
    try {
      var result = await new Promise(function(resolve, reject) {
        // Track active worker for cancellation
        activeWorkers.set(job.id, worker);
        emit('worker:spawned', { jobId: job.id, script: workerScriptName, reused: poolEntry.useCount > 1 });

        worker.onmessage = function(evt) {
          var payload = evt.data || {};
          if (payload.type === 'progress') {
            updateProgress(job, payload.progress || 0, payload.message || '');
            return;
          }
          // Terminal messages: done or error
          activeWorkers.delete(job.id);
          if (payload.type === 'error' || !payload.ok) {
            reject(new Error(payload.error || 'Unknown isolated worker failure'));
            return;
          }
          resolve(new Uint8Array(payload.outputBytes));
        };
        worker.onerror = function(err) {
          activeWorkers.delete(job.id);
          // On error, evict from pool since worker may be in bad state
          if (poolEntry.idleTimer) {
            clearTimeout(poolEntry.idleTimer);
          }
          worker.terminate();
          delete workerPool[workerScriptName];
          emit('worker:terminated', { jobId: job.id, script: workerScriptName, error: true });
          reject(new Error(err && err.message ? err.message : 'Worker error'));
        };
        worker.postMessage({
          scriptUrl: scriptUrl,
          exportName: exportName,
          jobId: job.id,
          jobType: job.type,
          inputPath: inputPath,
          outputPath: outputPath,
          payload: payloadText || '',
          inputBytes: inputBytes.buffer
        });
      });
      // Release back to pool for reuse
      releasePooledWorker(workerScriptName);
      emit('worker:released', { jobId: job.id, script: workerScriptName });
      return result;
    } catch (err) {
      // On failure, still try to release (the onerror handler may have already evicted)
      if (workerPool[workerScriptName]) {
        releasePooledWorker(workerScriptName);
      }
      throw err;
    }
  }

  // ── Backend execution helpers ─────────────────────────────────────────────

  async function writeStagedInputAndOutput(job, fileIndex, browserFile, inputBytes, outputBytes, outputFileName) {
    var stagedInput = stagedPathForJobFile(stagingInputDir(job), fileIndex, browserFile.name);
    var stagedOutput = stagedPathForJobFile(stagingOutputDir(job), fileIndex, outputFileName);
    writeBinary(stagedInput, inputBytes);
    writeBinary(stagedOutput, outputBytes);
    job.inputFiles.push(stagedInput);
    return stagedOutput;
  }

  function callbackStagedOutputToViewer(job, stagedOutputPath, outputFileName, sourceFileName, sourceIndex) {
    var legacyPath = callbackPathForJobFile(job, sourceIndex, outputFileName);
    var outputBytes = moduleRef.FS.readFile(stagedOutputPath);
    writeBinary(legacyPath, outputBytes);
    var hasSupported = false;
    if (typeof job.supportsFileName === 'function') {
      hasSupported = !!job.supportsFileName(sourceFileName);
    }
    if (!job.requestId) {
      invokeCppCallback(job, legacyPath, hasSupported);
    }
    return legacyPath;
  }

  // ── Backend: isolated XBF conversion (shared by STEP/IGES/mesh workers) ──

  async function isolatedXbfConversionBackendExecute(job, options) {
    if (!ensureJobDirectories(job)) {
      throw new Error('Failed to create staging directories');
    }
    var callbackTargets = [];
    for (var i = 0; i < job.browserFiles.length; ++i) {
      if (job.status === STATUS.Cancelled) {
        break;
      }
      var browserFile = job.browserFiles[i];
      var inputBytes = await readFileAsUint8Array(browserFile);
      updateProgress(job,
                     10 + Math.floor((i / job.browserFiles.length) * 70),
                     options.progressLabel + ': ' + browserFile.name);
      var outputBytes = await runIsolatedWasmConvert(options.scriptName,
                                                     options.exportName,
                                                     job,
                                                     browserFile,
                                                     inputBytes,
                                                     '');
      var outputFileName = xbfNameForSource(browserFile.name);
       var stagedOutput = await writeStagedInputAndOutput(job, i, browserFile, inputBytes, outputBytes, outputFileName);
      var callbackPath = callbackStagedOutputToViewer(job,
                                                      stagedOutput,
                                                      outputFileName,
                                                      browserFile.name,
                                                      i);
      callbackTargets.push(callbackPath);
      updateProgress(job,
                     85 + Math.floor(((i + 1) / job.browserFiles.length) * 15),
                     'Converted ' + (i + 1) + '/' + job.browserFiles.length + ' files');
    }
    return callbackTargets;
  }

  // ── Backend: local-inline ─────────────────────────────────────────────────

  async function localInlineBackendExecute(job) {
    if (!ensureJobDirectories(job)) {
      throw new Error('Failed to create staging directories');
    }

    updateProgress(job, 5, 'Preparing input files');
    var stagedInputs = [];
    for (var i = 0; i < job.browserFiles.length; ++i) {
      var browserFile = job.browserFiles[i];
      var bytes = await readFileAsUint8Array(browserFile);
      var stagePath = stagedPathForJobFile(stagingInputDir(job), i, browserFile.name);
      moduleRef.FS.writeFile(stagePath, bytes);
      stagedInputs.push(stagePath);
      updateProgress(job,
                     10 + Math.floor(((i + 1) / job.browserFiles.length) * 40),
                     'Staged ' + (i + 1) + '/' + job.browserFiles.length + ' files');
    }
    job.inputFiles = stagedInputs;

    var callbacksDone = 0;
    var callbackTargets = [];
    for (var j = 0; j < stagedInputs.length; ++j) {
      var sourcePath = stagedInputs[j];
      var fileName = job.browserFiles[j].name;
      var targetPath = copyToLegacyTmpPath(sourcePath, fileName, job, j);
      callbackTargets.push(targetPath);
      var hasSupported = false;
      if (typeof job.supportsFileName === 'function') {
        hasSupported = !!job.supportsFileName(fileName);
      }
      if (!job.requestId) {
        invokeCppCallback(job, targetPath, hasSupported);
      }
      callbacksDone += 1;
      updateProgress(job,
                     55 + Math.floor((callbacksDone / callbackTargets.length) * 45),
                     'Dispatched ' + callbacksDone + '/' + callbackTargets.length + ' files');
    }
    return callbackTargets;
  }

  // ── Backend: remote-http (async submit/poll/download) ─────────────────────

  async function remoteHttpBackendExecute(job) {
    if (!remoteBackendConfig.baseUrl) {
      throw new Error('Remote backend is enabled but baseUrl is empty.');
    }

    var baseUrl = remoteBackendConfig.baseUrl + remoteBackendConfig.endpoint;
    var headers = {};
    if (remoteBackendConfig.authToken) {
      headers['Authorization'] = 'Bearer ' + remoteBackendConfig.authToken;
    }

    // Step 1: Submit job with multipart upload
    updateProgress(job, 5, 'Submitting to remote backend');
    var formData = new FormData();
    formData.append('job', JSON.stringify(exportJob(job)));
    for (var i = 0; i < job.browserFiles.length; ++i) {
      formData.append('files', job.browserFiles[i], normalizeFileName(job.browserFiles[i].name));
    }

    var submitResponse = await fetch(baseUrl, {
      method: 'POST',
      headers: headers,
      body: formData
    });

    if (!submitResponse.ok) {
      // Fallback: try legacy JSON+base64 format for older servers
      var filesPayload = [];
      for (var fi = 0; fi < job.browserFiles.length; ++fi) {
        var browserFile = job.browserFiles[fi];
        var bytes = await readFileAsUint8Array(browserFile);
        filesPayload.push({
          name: normalizeFileName(browserFile.name),
          contentBase64: toBase64(bytes)
        });
      }
      var legacyHeaders = Object.assign({ 'Content-Type': 'application/json' }, headers);
      submitResponse = await fetch(baseUrl, {
        method: 'POST',
        headers: legacyHeaders,
        body: JSON.stringify({ job: exportJob(job), files: filesPayload })
      });
      if (!submitResponse.ok) {
        throw new Error('Remote backend submit failed: ' + submitResponse.status);
      }
    }

    var submitResult = await submitResponse.json();

    // If the response already contains output files, return immediately (sync mode)
    if (submitResult && Array.isArray(submitResult.files) && submitResult.files.length > 0) {
      return processRemoteOutputFiles(job, submitResult.files);
    }

    // Step 2: Poll for completion
    var remoteJobId = submitResult.jobId || submitResult.id || job.id;
    var pollUrl = baseUrl + '/' + remoteJobId;
    var pollStart = nowMs();
    updateProgress(job, 15, 'Processing on remote backend');

    while (true) {
      if (job.status === STATUS.Cancelled) {
        // Best-effort cancel on remote
        try {
          await fetch(pollUrl, { method: 'DELETE', headers: headers });
        } catch (e) { /* ignore */ }
        throw new Error('Job cancelled');
      }

      if (nowMs() - pollStart > remoteBackendConfig.pollTimeoutMs) {
        throw new Error('Remote backend poll timeout after ' + remoteBackendConfig.pollTimeoutMs + 'ms');
      }

      await new Promise(function(resolve) {
        setTimeout(resolve, remoteBackendConfig.pollIntervalMs);
      });

      var pollResponse = await fetch(pollUrl, { method: 'GET', headers: headers });
      if (!pollResponse.ok) {
        throw new Error('Remote backend poll failed: ' + pollResponse.status);
      }

      var pollResult = await pollResponse.json();
      var remoteStatus = pollResult.status || '';

      if (typeof pollResult.progress === 'number') {
        updateProgress(job, 15 + Math.floor(pollResult.progress * 0.75),
                       pollResult.message || 'Processing on remote backend');
      }

      if (remoteStatus === 'done' || remoteStatus === 'completed') {
        break;
      }
      if (remoteStatus === 'failed' || remoteStatus === 'error') {
        throw new Error('Remote backend job failed: ' + (pollResult.errorMessage || pollResult.message || 'unknown'));
      }
    }

    // Step 3: Download output
    updateProgress(job, 90, 'Downloading results');
    var outputUrl = pollUrl + '/output';
    var outputResponse = await fetch(outputUrl, { method: 'GET', headers: headers });
    if (!outputResponse.ok) {
      throw new Error('Remote backend output download failed: ' + outputResponse.status);
    }

    var contentType = outputResponse.headers.get('Content-Type') || '';
    if (contentType.indexOf('application/json') >= 0) {
      // JSON response with embedded files
      var outputPayload = await outputResponse.json();
      if (!outputPayload || !Array.isArray(outputPayload.files)) {
        throw new Error('Remote backend output response missing files array.');
      }
      return processRemoteOutputFiles(job, outputPayload.files);
    } else {
      // Binary response (single file)
      var outputBytes = new Uint8Array(await outputResponse.arrayBuffer());
      var outputName = xbfNameForSource(job.browserFiles.length > 0 ? job.browserFiles[0].name : 'output');
      var outPath = callbackPathForJobFile(job, 0, outputName);
      writeBinary(outPath, outputBytes);
      if (!job.requestId) {
        invokeCppCallback(job, outPath, true);
      }
      return [outPath];
    }
  }

  function processRemoteOutputFiles(job, files) {
    var outputPaths = [];
    for (var i = 0; i < files.length; ++i) {
      var item = files[i];
      if (!item || !item.name) {
        continue;
      }
      var outPath = callbackPathForJobFile(job, i, item.name);
      if (item.contentBase64) {
        writeBinary(outPath, fromBase64(item.contentBase64));
      } else if (item.bytes) {
        writeBinary(outPath, new Uint8Array(item.bytes));
      } else {
        continue;
      }
      outputPaths.push(outPath);
      if (!job.requestId) {
        invokeCppCallback(job, outPath, true);
      }
    }
    if (outputPaths.length === 0) {
      throw new Error('Remote backend returned no output files.');
    }
    return outputPaths;
  }

  // ── Backend registration ──────────────────────────────────────────────────

  function registerBackend(name, backend) {
    backends[name] = backend;
  }

  function findBackend(name) {
    return backends[name] || null;
  }

  // ── Job execution engine ──────────────────────────────────────────────────

  function countRunningJobsByType(type) {
    var count = 0;
    runningJobs.forEach(function(job) {
      if (job.type === type) {
        count++;
      }
    });
    return count;
  }

  async function runJob(job) {
    var backend = findBackend(job.backend);
    if (!backend) {
      job.errorMessage = 'No backend registered for ' + job.backend;
      setStatus(job, STATUS.Failed, job.errorMessage);
      return;
    }
    setStatus(job, STATUS.Assigned, 'Assigned to backend: ' + job.backend);
    runningJobs.set(job.id, job);
    setStatus(job, STATUS.Running, 'Running');
    writeHeartbeat(job);
    try {
      var outputs = await backend.execute(job);
      if (job.status === STATUS.Cancelled) {
        finishBrowserRequestJob(job, false);
        return;
      }
      recordBrowserRequestOutputs(job, Array.isArray(outputs) ? outputs : []);
      job.outputFiles = Array.isArray(outputs) ? outputs.slice() : [];
      job.progress = 100;
      setStatus(job, STATUS.Done, 'Completed');
      finishBrowserRequestJob(job, true);
    } catch (err) {
      if (job.status === STATUS.Cancelled) {
        finishBrowserRequestJob(job, false);
        return;
      }
      job.errorMessage = err && err.message ? err.message : String(err);
      if (job.retryCount < job.maxRetries) {
        job.retryCount += 1;
        setStatus(job, STATUS.Retrying, 'Retry ' + job.retryCount + '/' + job.maxRetries);
        pendingQueue.push(job);
      } else {
        setStatus(job, STATUS.Failed, job.errorMessage);
        finishBrowserRequestJob(job, false);
      }
    } finally {
      runningJobs.delete(job.id);
      pumpQueue();
    }
  }

  function pumpQueue() {
    if (!ensureFsReady()) {
      return;
    }
    while (runningJobs.size < concurrencyConfig.maxTotal && pendingQueue.length > 0) {
      // Find next job that doesn't exceed per-type limit
      var picked = -1;
      for (var i = 0; i < pendingQueue.length; ++i) {
        var candidate = pendingQueue[i];
        if (!candidate || candidate.status === STATUS.Cancelled) {
          pendingQueue.splice(i, 1);
          i--;
          continue;
        }
        if (countRunningJobsByType(candidate.type) < concurrencyConfig.maxPerType) {
          picked = i;
          break;
        }
      }
      if (picked < 0) {
        break;
      }
      var job = pendingQueue.splice(picked, 1)[0];
      runJob(job);
    }
  }

  // ── Heartbeat monitor ─────────────────────────────────────────────────────

  function monitorHeartbeats() {
    var currentTime = nowMs();
    runningJobs.forEach(function(job) {
      if (!job.lastHeartbeat) {
        return;
      }
      if ((currentTime - job.lastHeartbeat) > HEARTBEAT_TIMEOUT_MS) {
        job.errorMessage = 'Heartbeat timeout after ' + HEARTBEAT_TIMEOUT_MS + ' ms';
        setStatus(job, STATUS.Timeout, job.errorMessage);
        // Terminate active worker if any and evict from pool
        var worker = activeWorkers.get(job.id);
        if (worker) {
          worker.terminate();
          activeWorkers.delete(job.id);
          var poolKeys = Object.keys(workerPool);
          for (var k = 0; k < poolKeys.length; ++k) {
            var pool = workerPool[poolKeys[k]];
            if (pool && pool.worker === worker) {
              if (pool.idleTimer) {
                clearTimeout(pool.idleTimer);
              }
              delete workerPool[poolKeys[k]];
              break;
            }
          }
          emit('worker:terminated', { jobId: job.id, reason: 'timeout' });
        }
        runningJobs.delete(job.id);
        if (job.retryCount < job.maxRetries) {
          job.retryCount += 1;
          setStatus(job, STATUS.Retrying, 'Retry after timeout');
          pendingQueue.push(job);
        } else {
          setStatus(job, STATUS.Failed, job.errorMessage);
          finishBrowserRequestJob(job, false);
        }
      }
    });
    pumpQueue();
  }

  // ── State persistence / hydration ─────────────────────────────────────────

  function loadPersistedState() {
    if (!ensureFsReady()) {
      return;
    }
    try {
      var raw = readUtf8(JOBS_STATE_FILE);
      var parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.jobs)) {
        return;
      }
      for (var i = 0; i < parsed.jobs.length; ++i) {
        var persisted = parsed.jobs[i];
        if (!persisted || !persisted.id) {
          continue;
        }
        var job = {
          id: persisted.id,
          type: persisted.type || TYPE.BrowserImport,
          backend: persisted.backend || 'local-inline',
          status: persisted.status || STATUS.Done,
          callbackName: persisted.callbackName || 'CascadeScope_WasmFileUploaded',
          dropZone: typeof persisted.dropZone === 'number' ? persisted.dropZone : 0,
          createdAt: persisted.createdAt || nowMs(),
          assignedAt: persisted.assignedAt || null,
          startedAt: persisted.startedAt || null,
          completedAt: persisted.completedAt || null,
          lastHeartbeat: persisted.lastHeartbeat || null,
          retryCount: typeof persisted.retryCount === 'number' ? persisted.retryCount : 0,
          maxRetries: typeof persisted.maxRetries === 'number' ? persisted.maxRetries : DEFAULT_MAX_RETRIES,
          progress: typeof persisted.progress === 'number' ? persisted.progress : 0,
          progressMessage: persisted.progressMessage || '',
          errorMessage: persisted.errorMessage || '',
          inputFiles: Array.isArray(persisted.inputFiles) ? persisted.inputFiles.slice() : [],
          outputFiles: Array.isArray(persisted.outputFiles) ? persisted.outputFiles.slice() : [],
          supportsFileName: null,
          browserFiles: []
        };
        allJobs.set(job.id, job);
      }
    } catch (err) {
      if (!(err && err.code === 'ENOENT')) {
        console.warn('CascadeScopeWorkflow: failed to load persisted jobs', err);
      }
    }
  }

  // ── Worker manifest discovery ─────────────────────────────────────────────

  async function loadWorkerManifest() {
    try {
      var manifestUrl = resolveWorkerScriptUrl('workers-manifest.json');
      var response = await fetch(manifestUrl, { cache: 'no-store' });
      if (!response.ok) {
        return null;
      }
      workerManifest = await response.json();
      emit('manifest:loaded', workerManifest);
      return workerManifest;
    } catch (err) {
      console.warn('CascadeScopeWorkflow: failed to load worker manifest', err);
      return null;
    }
  }

  // ── Backend auto-probing ──────────────────────────────────────────────────
  // Probes all registered backends in parallel on attach. Results are cached
  // in backendAvailability and used by chooseBackendForType() to skip
  // unavailable backends without delaying job submission.

  async function probeAllBackends() {
    if (isProbing) {
      return;
    }
    isProbing = true;
    var names = Object.keys(backends);
    var probePromises = [];
    for (var i = 0; i < names.length; ++i) {
      (function(name) {
        var backend = backends[name];
        if (typeof backend.probe !== 'function') {
          backendAvailability[name] = true;
          return;
        }
        var p = backend.probe()
          .then(function(result) {
            backendAvailability[name] = !!(result && result.available);
            if (!backendAvailability[name]) {
              console.info('CascadeScopeWorkflow: backend "' + name + '" unavailable'
                + (result && result.reason ? ': ' + result.reason : ''));
            }
            emit('backend:probed', { name: name, available: backendAvailability[name], reason: result && result.reason });
          })
          .catch(function(err) {
            backendAvailability[name] = false;
            console.info('CascadeScopeWorkflow: backend "' + name + '" probe error: ' + (err && err.message || err));
            emit('backend:probed', { name: name, available: false, reason: err && err.message || String(err) });
          });
        probePromises.push(p);
      })(names[i]);
    }
    await Promise.all(probePromises);
    isProbing = false;
    emit('backends:ready', backendAvailability);
  }

  // ── Module attachment ─────────────────────────────────────────────────────

  function attachModule(mod) {
    moduleRef = mod;
    if (isAttached) {
      return;
    }
    isAttached = true;
    ensurePath(WORKFLOW_ROOT);
    ensurePath(STAGING_ROOT);
    ensurePath(STAGING_ROOT + '/jobs');
    loadPersistedState();
    monitorTimerId = setInterval(monitorHeartbeats, HEARTBEAT_INTERVAL_MS);
    schedulePersist();

    // Load worker manifest and probe backends in background
    loadWorkerManifest();
    probeAllBackends();

    emit('workflow:attached');
  }

  // ── Job creation ──────────────────────────────────────────────────────────

  function createBrowserImportJob(files, options) {
    var browserFiles = Array.prototype.slice.call(files || []);
    var createdAt = nowMs();
    var primaryType = (options && options.forcedType) ? options.forcedType : detectBatchType(browserFiles);
    var targetOutputFiles = [];
    for (var i = 0; i < browserFiles.length; ++i) {
      var sourceName = normalizeFileName(browserFiles[i].name);
      var typeForFile = detectImportType(sourceName);
      if (typeForFile === TYPE.StepImport || typeForFile === TYPE.IgesImport || typeForFile === TYPE.MeshImport) {
        targetOutputFiles.push('/cs_staging/planned/' + sourceName + '.xbf');
      } else {
        targetOutputFiles.push('/tmp/' + sourceName);
      }
    }
    var job = {
      id: makeJobId(),
      type: primaryType,
      backend: chooseBackendForType(primaryType, options && options.backend),
      requestId: (options && options.requestId) || '',
      requestOrderIndices: (options && Array.isArray(options.requestOrderIndices))
        ? options.requestOrderIndices.slice()
        : [],
      requestIsFinalized: false,
      status: STATUS.Pending,
      callbackName: (options && options.callbackName) || 'CascadeScope_WasmFileUploaded',
      dropZone: (options && typeof options.dropZone === 'number') ? options.dropZone : 0,
      createdAt: createdAt,
      assignedAt: null,
      startedAt: null,
      completedAt: null,
      lastHeartbeat: null,
      retryCount: 0,
      maxRetries: (options && typeof options.maxRetries === 'number') ? options.maxRetries : DEFAULT_MAX_RETRIES,
      progress: 0,
      progressMessage: '',
      errorMessage: '',
      inputFiles: [],
      outputFiles: targetOutputFiles,
      supportsFileName: options ? options.supportsFileName : null,
      browserFiles: browserFiles
    };
    return job;
  }

  function groupFilesByType(files) {
    var groups = Object.create(null);
    for (var i = 0; i < files.length; ++i) {
      var entry = files[i];
      var file = entry.file || entry;
      var type = detectImportType(file.name);
      if (!groups[type]) {
        groups[type] = {
          files: [],
          orderIndices: []
        };
      }
      groups[type].files.push(file);
      groups[type].orderIndices.push(typeof entry.orderIndex === 'number' ? entry.orderIndex : i);
    }
    return groups;
  }

  // ── Public API: enqueue browser files ─────────────────────────────────────

  function enqueueBrowserFiles(files, options) {
    if (!files || files.length === 0) {
      return null;
    }
    if (!ensureFsReady()) {
      console.warn('CascadeScopeWorkflow: runtime is not ready.');
      return null;
    }
    var browserFiles = Array.prototype.slice.call(files);
    var indexedFiles = browserFiles.map(function(file, index) {
      return { file: file, orderIndex: index };
    });
    var grouped = groupFilesByType(indexedFiles);
    var request = {
      id: makeRequestId(),
      callbackName: (options && options.callbackName) || 'CascadeScope_WasmFileUploaded',
      dropZone: (options && typeof options.dropZone === 'number') ? options.dropZone : 0,
      totalJobs: 0,
      completedJobs: 0,
      failedJobs: 0,
      callbackTargets: new Array(browserFiles.length),
      isDispatched: false
    };
    browserRequests.set(request.id, request);
    var jobIds = [];
    Object.keys(grouped).forEach(function(type) {
      var groupedEntry = grouped[type];
      var groupedOptions = Object.assign({}, options || {}, {
        forcedType: type,
        requestId: request.id,
        requestOrderIndices: groupedEntry.orderIndices
      });
      var job = createBrowserImportJob(groupedEntry.files, groupedOptions);
      request.totalJobs += 1;
      allJobs.set(job.id, job);
      setStatus(job, STATUS.Pending, 'Queued');
      pendingQueue.push(job);
      jobIds.push(job.id);
      emit('job:created', exportJob(job));
    });
    pumpQueue();
    if (jobIds.length === 0) {
      browserRequests.delete(request.id);
      return null;
    }
    return jobIds.length === 1 ? jobIds[0] : jobIds;
  }

  // ── Public API: enqueue meshing job ───────────────────────────────────────

  function enqueueMeshingJob(inputPath, outputPath, params) {
    if (!ensureFsReady()) {
      throw new Error('CascadeScopeWorkflow: runtime is not ready.');
    }
    var job = {
      id: makeJobId(),
      type: TYPE.Meshing,
      backend: chooseBackendForType(TYPE.Meshing, null),
      status: STATUS.Pending,
      callbackName: '',
      dropZone: 0,
      createdAt: nowMs(),
      assignedAt: null,
      startedAt: null,
      completedAt: null,
      lastHeartbeat: null,
      retryCount: 0,
      maxRetries: DEFAULT_MAX_RETRIES,
      progress: 0,
      progressMessage: '',
      errorMessage: '',
      inputFiles: [inputPath],
      outputFiles: [outputPath, outputPath + '.index.json'],
      supportsFileName: null,
      browserFiles: [],
      mesherInputPath: inputPath,
      mesherOutputPath: outputPath,
      mesherParams: params || {}
    };
    allJobs.set(job.id, job);
    setStatus(job, STATUS.Pending, 'Queued meshing');
    pendingQueue.push(job);
    emit('job:created', exportJob(job));
    pumpQueue();
    return job.id;
  }

  // ── Public API: cancel a job ──────────────────────────────────────────────

  function cancelJob(jobId) {
    var job = allJobs.get(jobId);
    if (!job) {
      return false;
    }
    if (job.status === STATUS.Done || job.status === STATUS.Failed || job.status === STATUS.Cancelled) {
      return false;
    }
    // If pending, just remove from queue
    for (var i = 0; i < pendingQueue.length; ++i) {
      if (pendingQueue[i] && pendingQueue[i].id === jobId) {
        pendingQueue.splice(i, 1);
        break;
      }
    }
    // If running, terminate the active worker and evict from pool
    var worker = activeWorkers.get(jobId);
    if (worker) {
      worker.terminate();
      activeWorkers.delete(jobId);
      // Evict from pool since the worker is now terminated
      var poolKeys = Object.keys(workerPool);
      for (var j = 0; j < poolKeys.length; ++j) {
        var pool = workerPool[poolKeys[j]];
        if (pool && pool.worker === worker) {
          if (pool.idleTimer) {
            clearTimeout(pool.idleTimer);
          }
          delete workerPool[poolKeys[j]];
          break;
        }
      }
      emit('worker:terminated', { jobId: jobId, reason: 'cancelled' });
    }
    runningJobs.delete(jobId);
    setStatus(job, STATUS.Cancelled, 'Cancelled by user');
    finishBrowserRequestJob(job, false);
    pumpQueue();
    return true;
  }

  // ── Public API: job queries ───────────────────────────────────────────────

  function listJobs(filter) {
    var jobs = [];
    allJobs.forEach(function(job) {
      if (filter) {
        if (filter.status && job.status !== filter.status) {
          return;
        }
        if (filter.type && job.type !== filter.type) {
          return;
        }
        if (filter.backend && job.backend !== filter.backend) {
          return;
        }
        if (typeof filter.since === 'number' && job.createdAt < filter.since) {
          return;
        }
      }
      jobs.push(exportJob(job));
    });
    jobs.sort(function(a, b) {
      return b.createdAt - a.createdAt;
    });
    return jobs;
  }

  function getJob(jobId) {
    var job = allJobs.get(jobId);
    return job ? exportJob(job) : null;
  }

  // ── Public API: worker assets ─────────────────────────────────────────────

  function listWorkerAssets() {
    // If manifest is loaded, use it
    if (workerManifest && Array.isArray(workerManifest.workers)) {
      return workerManifest.workers.map(function(w) {
        var url = resolveWorkerScriptUrl(w.script);
        return {
          name: w.name,
          script: w.script,
          wasm: w.wasm,
          exportName: w.exportName,
          formats: w.formats || [],
          url: url,
          isChecked: !!workerAssetChecks[url]
        };
      });
    }
    // Fallback to hardcoded list
    var scriptNames = [
      { name: 'cascadescope-step-worker', script: 'cascadescope-step-worker.js' },
      { name: 'cascadescope-iges-worker', script: 'cascadescope-iges-worker.js' },
      { name: 'cascadescope-mesh-worker', script: 'cascadescope-mesh-worker.js' },
      { name: 'cascadescope-mesher-worker', script: 'cascadescope-mesher-worker.js' }
    ];
    return scriptNames.map(function(entry) {
      var url = resolveWorkerScriptUrl(entry.script);
      return {
        name: entry.name,
        script: entry.script,
        url: url,
        isChecked: !!workerAssetChecks[url]
      };
    });
  }

  // ── Public API: configuration ─────────────────────────────────────────────

  function configureRemoteBackend(config) {
    config = config || {};
    remoteBackendConfig.enabled = !!config.enabled;
    remoteBackendConfig.baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl : '';
    remoteBackendConfig.authToken = typeof config.authToken === 'string' ? config.authToken : '';
    remoteBackendConfig.endpoint = typeof config.endpoint === 'string' && config.endpoint.length > 0
      ? config.endpoint
      : '/api/jobs';
    if (typeof config.pollIntervalMs === 'number' && config.pollIntervalMs > 0) {
      remoteBackendConfig.pollIntervalMs = config.pollIntervalMs;
    }
    if (typeof config.pollTimeoutMs === 'number' && config.pollTimeoutMs > 0) {
      remoteBackendConfig.pollTimeoutMs = config.pollTimeoutMs;
    }
  }

  function setConcurrency(config) {
    if (!config) {
      return;
    }
    if (typeof config.maxTotal === 'number' && config.maxTotal > 0) {
      concurrencyConfig.maxTotal = config.maxTotal;
    }
    if (typeof config.maxPerType === 'number' && config.maxPerType > 0) {
      concurrencyConfig.maxPerType = config.maxPerType;
    }
    if (typeof config.idleTerminateMs === 'number' && config.idleTerminateMs > 0) {
      concurrencyConfig.idleTerminateMs = config.idleTerminateMs;
    }
    pumpQueue();
  }

  // ── Register built-in backends ────────────────────────────────────────────

  registerBackend('local-inline', {
    name: 'local-inline',
    type: 'local-inline',
    probe: async function() { return { available: true }; },
    execute: localInlineBackendExecute,
    cancel: function() {}
  });

  registerBackend('worker-step', {
    name: 'worker-step',
    type: 'wasm-worker',
    probe: async function() {
      try {
        await ensureWorkerScriptAvailable('cascadescope-step-worker.js');
        return { available: true };
      } catch (err) {
        return { available: false, reason: err.message };
      }
    },
    execute: function(job) {
      return isolatedXbfConversionBackendExecute(job, {
        scriptName: 'cascadescope-step-worker.js',
        exportName: 'CascadeScopeStepWorkerModule',
        progressLabel: 'Converting STEP to XBF'
      });
    },
    cancel: function(job) { cancelJob(job.id); }
  });

  registerBackend('worker-iges', {
    name: 'worker-iges',
    type: 'wasm-worker',
    probe: async function() {
      try {
        await ensureWorkerScriptAvailable('cascadescope-iges-worker.js');
        return { available: true };
      } catch (err) {
        return { available: false, reason: err.message };
      }
    },
    execute: function(job) {
      return isolatedXbfConversionBackendExecute(job, {
        scriptName: 'cascadescope-iges-worker.js',
        exportName: 'CascadeScopeIgesWorkerModule',
        progressLabel: 'Converting IGES to XBF'
      });
    },
    cancel: function(job) { cancelJob(job.id); }
  });

  registerBackend('worker-mesh', {
    name: 'worker-mesh',
    type: 'wasm-worker',
    probe: async function() {
      try {
        await ensureWorkerScriptAvailable('cascadescope-mesh-worker.js');
        return { available: true };
      } catch (err) {
        return { available: false, reason: err.message };
      }
    },
    execute: function(job) {
      return isolatedXbfConversionBackendExecute(job, {
        scriptName: 'cascadescope-mesh-worker.js',
        exportName: 'CascadeScopeMeshWorkerModule',
        progressLabel: 'Converting mesh format to XBF'
      });
    },
    cancel: function(job) { cancelJob(job.id); }
  });

  registerBackend('worker-mesher', {
    name: 'worker-mesher',
    type: 'wasm-worker',
    probe: async function() {
      try {
        await ensureWorkerScriptAvailable('cascadescope-mesher-worker.js');
        return { available: true };
      } catch (err) {
        return { available: false, reason: err.message };
      }
    },
    execute: async function(job) {
      var payload = [
        'deflection=' + (job.mesherParams.deflection != null ? job.mesherParams.deflection : 0.001),
        'angle=' + (job.mesherParams.angle != null ? job.mesherParams.angle : 0.5),
        'relative=' + (job.mesherParams.relative ? 1 : 0),
        'parallel=' + (job.mesherParams.parallel ? 1 : 0)
      ].join(';');
      var browserFile = { name: normalizeFileName(job.mesherInputPath) };
      var inputBytes = moduleRef.FS.readFile(job.mesherInputPath);
      updateProgress(job, 20, 'Meshing in isolated worker');
      var outputBytes = await runIsolatedWasmConvert('cascadescope-mesher-worker.js',
                                                     'CascadeScopeMesherWorkerModule',
                                                     job,
                                                     browserFile,
                                                     inputBytes,
                                                     payload);
      writeBinary(job.mesherOutputPath, outputBytes);
      var indexPath = job.mesherOutputPath + '.index.json';
      writeUtf8(indexPath, JSON.stringify({
        version: 1,
        source: job.mesherInputPath,
        output: job.mesherOutputPath,
        status: 'done',
        message: 'Meshing completed in isolated worker.',
        meshParams: {
          deflection: (job.mesherParams.deflection != null ? job.mesherParams.deflection : 0.001),
          angle: (job.mesherParams.angle != null ? job.mesherParams.angle : 0.5),
          relative: !!job.mesherParams.relative,
          inParallel: !!job.mesherParams.parallel
        }
      }, null, 2));
      updateProgress(job, 100, 'Meshing complete');
      return [job.mesherOutputPath, indexPath];
    },
    cancel: function(job) { cancelJob(job.id); }
  });

  registerBackend('remote-http', {
    name: 'remote-http',
    type: 'remote-http',
    probe: async function() {
      if (!remoteBackendConfig.enabled || !remoteBackendConfig.baseUrl) {
        return { available: false, reason: 'Remote backend not configured' };
      }
      try {
        var headers = {};
        if (remoteBackendConfig.authToken) {
          headers['Authorization'] = 'Bearer ' + remoteBackendConfig.authToken;
        }
        var healthUrl = remoteBackendConfig.baseUrl + '/health';
        var response = await fetch(healthUrl, { method: 'GET', headers: headers, cache: 'no-store' });
        return { available: response.ok };
      } catch (err) {
        return { available: false, reason: err.message };
      }
    },
    execute: remoteHttpBackendExecute,
    cancel: function(job) {
      if (!remoteBackendConfig.baseUrl) {
        return;
      }
      var headers = {};
      if (remoteBackendConfig.authToken) {
        headers['Authorization'] = 'Bearer ' + remoteBackendConfig.authToken;
      }
      fetch(remoteBackendConfig.baseUrl + remoteBackendConfig.endpoint + '/' + job.id, {
        method: 'DELETE',
        headers: headers
      }).catch(function() {});
      cancelJob(job.id);
    }
  });

  // ── Public API ────────────────────────────────────────────────────────────

  global.CascadeScopeWorkflow = {
    // Enums
    STATUS: STATUS,
    TYPE: TYPE,

    // Events
    on: on,
    off: off,

    // Module lifecycle
    attachModule: attachModule,

    // Job management
    enqueueBrowserFiles: enqueueBrowserFiles,
    enqueueMeshingJob: enqueueMeshingJob,
    cancelJob: cancelJob,
    getJob: getJob,
    listJobs: listJobs,

    // Backend management
    registerBackend: registerBackend,
    configureRemoteBackend: configureRemoteBackend,
    configureBackendPriority: configureBackendPriority,

    // Worker management
    listWorkerAssets: listWorkerAssets,
    loadWorkerManifest: loadWorkerManifest,
    probeAllBackends: probeAllBackends,
    getBackendAvailability: function() {
      var result = Object.create(null);
      var keys = Object.keys(backendAvailability);
      for (var i = 0; i < keys.length; ++i) {
        result[keys[i]] = backendAvailability[keys[i]];
      }
      return result;
    },

    // Configuration
    setConcurrency: setConcurrency,

    // Cleanup
    terminateAllPooledWorkers: terminateAllPooledWorkers
  };
})(typeof window !== 'undefined' ? window : this);
