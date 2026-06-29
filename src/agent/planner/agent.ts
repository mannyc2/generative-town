/**
 * Planner Agent (Sequential Phases)
 *
 * Executes map generation in 3 sequential phases:
 * 1. Ground Phase - Fill all ground tiles (100% coverage)
 * 2. Roads Phase - Build connected road network
 * 3. Objects Phase - Place buildings and props
 *
 * Architecture Decision:
 * - Sequential chain pattern for predictable execution order
 * - Each phase has focused prompt and limited tool set
 * - Shared GridState flows through all phases
 */

import { Console, Effect } from 'effect';
import { GridState } from '../lib/grid-state';
import { executeGroundPhase } from './phases/ground-phase';
import { executeRoadsPhase } from './phases/roads-phase';
import { executeObjectsPhase } from './phases/objects-phase';
import type { SpritesheetMetadata, GameMap } from '../types';
import { DEFAULT_MAP_SIZE } from '../config';

/**
 * Planner workflow with sequential phase execution.
 *
 * @param metadata - Spritesheet metadata from Designer
 * @param width - Map width in tiles (default: 10)
 * @param height - Map height in tiles (default: 10)
 * @param verbose - Enable detailed logging
 * @returns Complete GameMap JSON
 */
export const runPlannerEffect = Effect.fn('Planner.run')(function*(
  metadata: SpritesheetMetadata,
  width = DEFAULT_MAP_SIZE,
  height = DEFAULT_MAP_SIZE,
  verbose = false
) {
  // Shared state across all phases
  const grid = new GridState(width, height, metadata);

  // Extract scene description for visual context (with fallback)
  // This enables each phase to make thematically coherent decisions
  const sceneDescription =
    metadata.sceneDescription ?? `A ${metadata.theme} themed environment.`;

  if (verbose) {
    yield* Console.log(`[Planner] Starting ${width}x${height} map generation...`);
    yield* Console.log(`[Planner] Scene context: ${sceneDescription.length} chars available`);
  }

  // Phase 1: Fill ground tiles
  yield* executeGroundPhase(grid, metadata, width, height, verbose, sceneDescription);

  if (verbose) {
    const stats = grid.getStats();
    yield* Console.log(`[Planner] Ground: ${stats.groundFilled}/${stats.totalTiles} tiles`);
  }

  // Phase 2: Build road network
  yield* executeRoadsPhase(grid, metadata, width, height, verbose, sceneDescription);

  if (verbose) {
    const connectivity = grid.validateRoadConnectivity();
    yield* Console.log(
      `[Planner] Roads: ${connectivity.totalRoadTiles} tiles, connected=${connectivity.connected}`
    );
  }

  // Phase 3: Place buildings and props
  yield* executeObjectsPhase(grid, metadata, width, height, verbose, sceneDescription);

  if (verbose) {
    const stats = grid.getStats();
    yield* Console.log(`[Planner] Objects: ${stats.objectsFilled} placed`);
    yield* Console.log(`[Planner] Complete!`);
  }

  return grid.toJSON();
});

/**
 * Promise boundary for existing callers and CLI code.
 */
export function runPlannerAgent(
  metadata: SpritesheetMetadata,
  width = DEFAULT_MAP_SIZE,
  height = DEFAULT_MAP_SIZE,
  verbose = false
): Promise<GameMap> {
  return Effect.runPromise(runPlannerEffect(metadata, width, height, verbose));
}
