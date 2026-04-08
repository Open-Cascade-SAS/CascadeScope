/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
let coepCredentialless = false;
if (typeof window === 'undefined') {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener("message", (ev) => {
    if (!ev.data) {
      return;
    }
    if (ev.data.type === "deregister") {
      self.registration
        .unregister()
        .then(() => self.clients.matchAll())
        .then((clients) => {
          clients.forEach((client) => client.navigate(client.url));
        });
      return;
    }
    if (ev.data.type === "coepCredentialless") {
      coepCredentialless = ev.data.value;
    }
  });

  self.addEventListener("fetch", (event) => {
    const aRequest = event.request;
    if (aRequest.cache === "only-if-cached" && aRequest.mode !== "same-origin") {
      return;
    }

    const aFetchRequest = (coepCredentialless && aRequest.mode === "no-cors")
      ? new Request(aRequest, { credentials: "omit" })
      : aRequest;

    event.respondWith(
      fetch(aFetchRequest)
        .then((response) => {
          if (response.status === 0) {
            return response;
          }

          const aHeaders = new Headers(response.headers);
          aHeaders.set(
            "Cross-Origin-Embedder-Policy",
            coepCredentialless ? "credentialless" : "require-corp"
          );
          if (!coepCredentialless) {
            aHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
          }
          aHeaders.set("Cross-Origin-Opener-Policy", "same-origin");

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: aHeaders,
          });
        })
        .catch((theError) => console.error(theError))
    );
  });
} else {
  (() => {
    const aCoi = {
      shouldRegister: () => true,
      shouldDeregister: () => false,
      coepCredentialless: () => !(window.chrome || window.netscape),
      doReload: () => window.location.reload(),
      quiet: false,
      ...window.coi,
    };

    const aNavigator = navigator;

    if (aNavigator.serviceWorker && aNavigator.serviceWorker.controller) {
      aNavigator.serviceWorker.controller.postMessage({
        type: "coepCredentialless",
        value: aCoi.coepCredentialless(),
      });

      if (aCoi.shouldDeregister()) {
        aNavigator.serviceWorker.controller.postMessage({ type: "deregister" });
      }
    }

    if (window.crossOriginIsolated !== false || !aCoi.shouldRegister()) {
      return;
    }

    if (!window.isSecureContext) {
      if (!aCoi.quiet) {
        console.log("COOP/COEP Service Worker not registered, a secure context is required.");
      }
      return;
    }

    if (aNavigator.serviceWorker) {
      aNavigator.serviceWorker.register(window.document.currentScript.src).then(
        (theRegistration) => {
          if (!aCoi.quiet) {
            console.log("COOP/COEP Service Worker registered", theRegistration.scope);
          }

          theRegistration.addEventListener("updatefound", () => {
            if (!aCoi.quiet) {
              console.log("Reloading page to make use of updated COOP/COEP Service Worker.");
            }
            aCoi.doReload();
          });

          if (theRegistration.active && !aNavigator.serviceWorker.controller) {
            if (!aCoi.quiet) {
              console.log("Reloading page to make use of COOP/COEP Service Worker.");
            }
            aCoi.doReload();
          }
        },
        (theError) => {
          if (!aCoi.quiet) {
            console.error("COOP/COEP Service Worker failed to register:", theError);
          }
        }
      );
    }
  })();
}