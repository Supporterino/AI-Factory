## Graph first

The workspace has one knowledge graph over all repos. Query it before opening files, then read only the ranges you need:
- `graphify query "<question>" --graph "$AI_FACTORY_GRAPH" --budget 1500` for where something lives and what it touches.
- `graphify explain "<path>::<Symbol>" --graph "$AI_FACTORY_GRAPH"` for one symbol, its callers and callees.
- `graphify path "<A>" "<B>" --graph "$AI_FACTORY_GRAPH"` for how two things connect.
- `graphify affected "<path>::<Symbol>" --graph "$AI_FACTORY_GRAPH"` for what a change can break.
  Exit code 3 means ambiguous (qualify the name), 4 means no match (search with grep instead).
  Do not re-read a file you already read unless it changed. Never run `graphify update`; the factory updates the graph.
