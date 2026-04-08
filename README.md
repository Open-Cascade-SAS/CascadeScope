# CascadeScope

CascadeScope is an advanced demo application built around Open CASCADE Technology (OCCT) for exploring complex product structures, B-Rep topology, and modern graph-based engineering workflows.

This public repository is the presentation and demo-delivery side of CascadeScope. It is intended to host the main project description, technical notes, and a static WebAssembly deployment for GitHub Pages. The application source code is available on request from OCCT3D.

Target public repository:

- https://github.com/Open-Cascade-SAS/CascadeScope

## What CascadeScope Demonstrates

CascadeScope is designed as a practical inspection workbench for the new BRepGraph and BRepGraphInc logic in OCCT. It brings together several technical directions that are especially important for advanced CAD and engineering applications:

- BRepGraph-centric exploration of products, occurrences, topology, and shared geometry
- advanced OCCT algorithms for topology traversal, bounding, meshing, diagnostics, and graph-aware visualization
- XCAF-based document workflows for structured CAD data and metadata-rich product assemblies
- multi-view inspection of the same model through tree, table, connectivity, properties, diagnostics, and 3D visualization panes
- native desktop and browser-oriented deployment paths for demos, training, and evaluation

The target platforms for CascadeScope are Linux, Windows, macOS, and Web.

## Key Technical Highlights

- Built on OCCT with a focus on BRepGraph and BRepGraphInc storage and navigation workflows
- Integrates XCAF document handling for assembly-aware and metadata-aware engineering sessions
- Supports data-exchange driven inspection scenarios for formats such as STEP, IGES, STL, OBJ, PLY, BREP, and related OCCT document flows
- Combines structural navigation with live 3D preview, selection context, connectivity inspection, and validation-oriented diagnostics
- Uses an OCCT viewer bridge together with a dockable UI workbench for multi-pane investigation of the same engineering model
- Prepared for browser delivery through a WebAssembly build that can be hosted as a static site

Additional product details are collected in [docs/technical-overview.md](docs/technical-overview.md).

## Source Code Access

CascadeScope source code is available on request from OCCT3D.

To request more details, use the Contact us button on the OCCT3D components page:

- https://occt3d.com/components/

## Training And Enablement

OCCT is preparing e-learning materials to cover BRepGraph logic and related engineering workflows.

OCCT also offers online and on-site training with OCCT experts for teams that want to adopt these technologies in real products, internal tools, or evaluation programs.

## Web Demo

The WebAssembly demo is published through GitHub Pages.

Expected public viewer URLs:

- Site root: https://open-cascade-sas.github.io/CascadeScope/
- Direct viewer entry: https://open-cascade-sas.github.io/CascadeScope/CascadeScope.html

The site root opens the hosted viewer automatically and forwards to `CascadeScope.html`.

## Repository Scope

This public repository is intended to contain:

- the main project README
- public technical notes and product positioning
- a static browser demo deployment

It is not intended to expose the private development history or the full application sources by default.