import { logger } from "./logger.js";

/**
 * Log a line for real-time streaming to the web-ui.
 * Call this alongside logs.push() for real-time updates.
 *
 * Example usage in a node:
 *   const logs: string[] = [];
 *   const l = loggerFor("planTests", logs);
 *   l("Starting planning...");  // Pushes to array AND emits realtime
 *
 * @param node - The node name (e.g., "planTests", "generateTests")
 * @param line - The log line to emit
 */
export function log(node: string, line: string): void {
  logger.log(node, line);
}

/**
 * Create a logger function that both accumulates in an array AND emits real-time.
 * This is the preferred pattern for nodes.
 *
 * Example:
 *   const logs: string[] = [];
 *   const l = loggerFor("planTests", logs);
 *   l("Starting...");  // Does both: logs.push() + realtime emit
 *   l("Progress: 50%");
 *   return respond(state, { logs });  // logs array already populated
 *
 * @param node - The node name
 * @param logsArray - The local logs array to accumulate in
 * @returns A function that logs to both array and realtime stream
 */
export function loggerFor(
  node: string,
  logsArray: string[]
): (line: string) => void {
  return (line: string) => {
    logsArray.push(line);
    logger.log(node, line);
  };
}

/**
 * Create a bound logger function for a specific node (real-time only).
 * Use this when you don't need to accumulate in a local array.
 *
 * Example:
 *   const nodeLog = createNodeLogger("planTests");
 *   nodeLog("Starting...");
 *   nodeLog("Progress: 50%");
 *
 * @param node - The node name
 * @returns A function that logs to that node
 */
export function createNodeLogger(node: string): (line: string) => void {
  return (line: string) => logger.log(node, line);
}
