# CascadeScope Technical Overview

## Product Focus

CascadeScope is a focused OCCT demo application for inspecting modern engineering models through BRepGraph-driven workflows. Its goal is not only to display geometry, but also to make graph structure, shared usage, occurrences, topology relations, metadata, and diagnostics easier to understand in one place.

## Technical Themes

## BRepGraph And BRepGraphInc

CascadeScope is centered on the new BRepGraph logic and related incremental storage concepts. This makes it relevant for scenarios where understanding product structure, graph connectivity, topology sharing, and fine-grained selection context matters more than a simple file viewer.

Practical value areas include:

- traversal of products, occurrences, and topological entities
- inspection of parent-child and usage relationships
- graph-oriented selection and synchronization between UI panes
- diagnostics and validation-oriented investigation of complex structures

## OCCT Integration

CascadeScope is built on OCCT services that support several layers of engineering analysis and visualization:

- topology and shape exploration
- meshing and display preparation
- viewer and interactive context services
- color and metadata-aware visualization paths
- document-based data loading and assembly handling

This makes CascadeScope useful both as a demonstration vehicle and as a reference point for teams evaluating how graph-aware OCCT tooling can be exposed in real applications.

## XCAF And Structured Data

One important aspect of CascadeScope is its XCAF-oriented workflow. Instead of treating every input as an isolated shape, the application can work with document-style engineering content where assembly structure, labels, product organization, and metadata are part of the inspection task.

That direction is important for:

- assembly-aware navigation
- product and occurrence views
- metadata-driven exploration
- richer enterprise and exchange scenarios

## Data Exchange And Inspection Scenarios

CascadeScope is intended for inspection scenarios driven by OCCT data exchange and related model loading flows. Public-facing examples include:

- STEP and IGES for engineering exchange
- STL, OBJ, and PLY for mesh-oriented data review
- BREP and XCAF-oriented sessions for OCCT-native workflows

The exact public demo payload may evolve over time, but the technical direction is to show how advanced OCCT import and graph-building logic can be exposed through a compact application workflow.

## User Experience Direction

CascadeScope is designed as a multi-pane workbench rather than a single-view viewer. The current public description assumes the following families of views:

- structural tree navigation
- tabular inspection
- connectivity-oriented views
- properties and diagnostics panels
- live 3D OCCT preview

This layout is meant to help engineers move between product hierarchy, topological facts, and visual context without losing selection state.

## Browser Delivery

CascadeScope also has a WebAssembly deployment path so the demo can be hosted as a static web application. That capability is important for:

- lightweight evaluations
- training and enablement material
- remote demo delivery without native installation
- quick access for customer discussions and technical reviews

For the first public repository version, the recommended publishing model is a simple GitHub Pages deployment with manually copied build artifacts.

## Training

In addition to the demo application itself, OCCT plans to provide e-learning materials covering BRepGraph logic and related model navigation concepts.

Online and on-site expert training can also be offered to help engineering teams connect the demo ideas to production OCCT workflows.