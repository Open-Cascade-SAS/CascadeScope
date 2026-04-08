# CascadeScope Viewer

## Purpose

CascadeScope is a graph-oriented engineering-model viewer built around the
public OCCT `BRepGraph` and `BRepGraphInc` classes. It is intended as a
demonstration of advanced model exploration workflows, where model structure,
topology, relationships, and attributes are handled in the BRepGraph model.

The viewer is delivered as a prebuilt WebAssembly demonstration. This
repository does not publish its source code, private implementation classes,
SDK interfaces, bindings, or headers.

## Viewer Workbench

The viewer provides a dockable workbench for investigating a loaded model from
several synchronized perspectives:

- 3D model display with navigation, display controls, clipping, and selection
- hierarchy and graph views for structure and relationship exploration
- inspector and output views for geometry, topology, attributes, and results
- connectivity exploration, graph operations, and graph checks
- topology and UV inspection
- primitive creation and distance measurement

The exact commands and available importers can vary between delivered builds.
The public demo should be treated as a demonstration viewer, not as a
general-purpose data-exchange product or a specification of a public API.

## BRepGraph Focus

CascadeScope presents model information through BRepGraph data. Model
attributes and graph relationships are explored with the same graph-oriented
workflow as the geometry and topology they describe.

`BRepGraph` and `BRepGraphInc` are the public OCCT classes demonstrated by this
viewer. Other CascadeScope components are private implementation details and
are not made public by this repository or distributed demo materials.

## Native BRepGraph Operations

CascadeScope applies its model-processing operations directly to the BRepGraph
representation. The workbench demonstrates the following graph-native
operations without converting the model to a separate document representation:

- shape healing
- sewing
- unification of same-domain faces and edge chains
- edge fusion
- BRepGraph validity checks

Operations report their results in the viewer so that changes, rejected cases,
and detected issues can be inspected in the same graph-oriented context as the
source model. Depending on the operation, the scope can be the complete model
or the selected graph content.

## Delivery And Licensing

CascadeScope is delivered as WebAssembly binary assets for demonstration and
evaluation. The delivery does not provide source packages or standalone
third-party libraries.

OCCT software included in a CascadeScope delivery is made available by Open
Cascade under commercial terms. It is not distributed under LGPL-2.1 as part of
this delivery.

CascadeScope and its accompanying materials are proprietary. This repository
does not grant a source-code license, SDK license, or rights to private
implementation classes. The applicable delivery terms govern use and
redistribution of CascadeScope.

Third-party notices included with a delivery identify the relevant material and
its applicable terms. They do not grant rights to CascadeScope or other
proprietary materials delivered with it.
