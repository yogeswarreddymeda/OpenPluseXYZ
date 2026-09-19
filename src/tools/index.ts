import { ToolRegistry, type Tool } from "./registry.js";
import { fileTools } from "./file.js";
import { searchTools } from "./search.js";
import { shellTools } from "./shell.js";
import { gitTools } from "./git.js";

export function createDefaultTools(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [...fileTools, ...searchTools, ...shellTools, ...gitTools] as Tool[]) {
    registry.register(tool);
  }
  return registry;
}

export { ToolRegistry, type Tool, type ToolContext } from "./registry.js";