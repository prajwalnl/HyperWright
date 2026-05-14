import fs from "node:fs/promises";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

async function safeRead(absPath: string): Promise<string> {
  try {
    const raw = await fs.readFile(absPath, "utf8");
    return raw.length > 40_000 ? raw.slice(0, 40_000) + "\n…(truncated)" : raw;
  } catch (err) {
    return `ERROR: ${(err as Error).message}`;
  }
}

async function safeList(dir: string): Promise<string> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join("\n");
  } catch (err) {
    return `ERROR: ${(err as Error).message}`;
  }
}

export const readFileTool = tool(
  async ({ path: p }: { path: string }) => {
    const abs = path.resolve(process.cwd(), p);
    return safeRead(abs);
  },
  {
    name: "read_file",
    description:
      "Read a UTF-8 file (first 40k chars). Relative paths resolve from the current working directory.",
    schema: z.object({ path: z.string() }),
  },
);

export const listDirTool = tool(
  async ({ path: p }: { path: string }) => {
    const abs = path.resolve(process.cwd(), p);
    return safeList(abs);
  },
  {
    name: "list_dir",
    description: "List entries in a directory (one per line).",
    schema: z.object({ path: z.string() }),
  },
);

export const fsTools = [readFileTool, listDirTool];
