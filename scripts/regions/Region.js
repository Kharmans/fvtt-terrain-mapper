/* globals
canvas,
foundry,
Hooks,
PIXI,
Region
*/
/* eslint no-unused-vars: ["error", { "argsIgnorePattern": "^_" }] */
"use strict";


/*
Methods and hooks related to tokens.
Hook token movement to add/remove terrain effects and pause tokens dependent on settings.
*/

import { MODULE_ID, FLAGS, MOVEMENT_TYPES } from "../const.js";
import { Matrix } from "../geometry/Matrix.js";
import { regionWaypointsXYEqual, regionWaypointsEqual, findSetElevation } from "../util.js";

export const PATCHES = {};
PATCHES.REGIONS = {};

/* Modify Region#segmentizeMovement to handle elevation options.

1. Plateau
--> Move token from any elevation w/in region to defined elevation.
- If token enters the region, redo waypoints.
- If token exits the region, redo waypoints if reset is true.


2. Ramp / Steps
--> In a user-defined direction, the region increases elevation from a defined min to a defined max.
--> Any token moving in the region has elevation adjusted accordingly
--> User can define the step size

2. Stairs
--> Define halfway point between two elevations. Tokens below halfway point go up to set upper elevation.
    Tokens above halfway point go down to set lower elevation.

Options:
• Teleport. Ignore other regions. Elevation movement is a teleport that will not trigger overlapping regions.
  Acts as exit for other regions at start, followed by enter for other regions at end.
• Ignore Other Elevations. Ignore tokens not at top/bottom elevation points when entering.

Ignores tokens within the region already that may be at a different elevation.
For ramp, tokens not at the defined elevation are not moved to the next up/down step.

When exiting, moves back to the scene elevation

(No dialog option; use levels stairs/elevator for that region behavior.)


*/

// ----- NOTE: Hooks ----- //

/**
 * On init, add the terrain mapper refresh flag.
 */
Hooks.on("init", function() {
  Region.RENDER_FLAGS.refreshTerrainMapperMesh = {};
  Region.RENDER_FLAGS.refreshBorder.propagate ??= [];
  Region.RENDER_FLAGS.refreshBorder.propagate.push("refreshTerrainMapperMesh");
});

/**
 * Hook canvasReady
 * Check if region behaviors have defined min/max and update
 * @param {Canvas} canvas The Canvas which is now ready for use
 */
export function canvasReady(canvas) {
  for ( const region of canvas.regions.placeables ) {
    for ( const behavior of region.document.behaviors ) {
      if ( behavior.type !== `${MODULE_ID}.setElevation` ) continue;
      if ( behavior.getFlag(MODULE_ID, FLAGS.REGION.MIN_MAX) ) continue;
      const minMax = minMaxRegionPointsAlongAxis(region, behavior.system.rampDirection);
      behavior.setFlag(MODULE_ID, FLAGS.REGION.MIN_MAX, minMax); // Async.
    }
  }
}

/**
 * Hook updateRegion
 * If the region changes, update any ramp elevation behaviors with the new shape.
 * @param {Document} document                       The existing Document which was updated
 * @param {object} changed                          Differential data that was used to update the document
 * @param {Partial<DatabaseUpdateOperation>} options Additional options which modified the update request
 * @param {string} userId                           The ID of the User who triggered the update workflow
 */
function updateRegion(regionDoc, changed, _options, _userId) {
  if ( !Object.hasOwn(changed, "shapes") ) return;
  const region = regionDoc.object;
  if ( !region ) return;
  for ( const behavior of regionDoc.behaviors ) {
    if ( behavior.type !== `${MODULE_ID}.setElevation` ) continue;
    if ( behavior.system.algorithm !== FLAGS.REGION.CHOICES.RAMP ) continue;
    const minMax = minMaxRegionPointsAlongAxis(region, behavior.system.rampDirection);
    behavior.setFlag(MODULE_ID, FLAGS.REGION.MIN_MAX, minMax); // Async.
  }
}

/**
 * Hook preUpdate region behavior
 * Change the ramp min/max points for the current settings.
 * @param {Document} document                       The existing Document which was updated
 * @param {object} changed                          Differential data that was used to update the document
 * @param {Partial<DatabaseUpdateOperation>} options Additional options which modified the update request
 * @param {string} userId                           The ID of the User who triggered the update workflow
 */
function preUpdateRegionBehavior(regionBehaviorDoc, changed, _options, _userId) {
  if ( regionBehaviorDoc.type !== `${MODULE_ID}.setElevation` ) return;
  if ( !Object.hasOwn(changed, "system") ) return;
  if ( !(Object.hasOwn(changed.system, "algorithm") || Object.hasOwn(changed.system, "rampDirection")) ) return;
  const algorithm = changed.system.algorithm || regionBehaviorDoc.system.algorithm;
  if ( algorithm !== FLAGS.REGION.CHOICES.RAMP ) return;
  const region = regionBehaviorDoc.parent?.object;
  if ( !region ) return;
  const direction = changed.system.rampDirection ?? regionBehaviorDoc.system.rampDirection ?? 0;
  const minMax = minMaxRegionPointsAlongAxis(region, direction);
  foundry.utils.setProperty(changed, `flags.${MODULE_ID}.${FLAGS.REGION.MIN_MAX}`, minMax);
}

/**
 * Hook updateRegionBehavior
 * Update the region's mesh shader if the setElevation behavior changes.
 * @param {Document} document                       The existing Document which was updated
 * @param {object} changed                          Differential data that was used to update the document
 * @param {Partial<DatabaseUpdateOperation>} options Additional options which modified the update request
 * @param {string} userId                           The ID of the User who triggered the update workflow
 */
function updateRegionBehavior(regionBehaviorDoc, _changed, _options, _userId) {
  if ( regionBehaviorDoc.type !== `${MODULE_ID}.setElevation` ) return;
  const region = regionBehaviorDoc.parent?.object;
  if ( !region ) return;
  region.renderFlags.set({ "refreshTerrainMapperMesh": true });
}

/**
 * Hook deleteRegionBehavior
 * Update the region's mesh shader
 * @param {Document} document                       The existing Document which was deleted
 * @param {Partial<DatabaseDeleteOperation>} options Additional options which modified the deletion request
 * @param {string} userId                           The ID of the User who triggered the deletion workflow
 */
function deleteRegionBehavior(regionBehaviorDoc, _options, _userId) {
  if ( regionBehaviorDoc.type !== `${MODULE_ID}.setElevation` ) return;
  const region = regionBehaviorDoc.parent?.object;
  if ( !region ) return;
  region.renderFlags.set({ "refreshTerrainMapperMesh": true });
}


PATCHES.REGIONS.HOOKS = { canvasReady, updateRegion, preUpdateRegionBehavior, updateRegionBehavior, deleteRegionBehavior };



// ----- NOTE: Wraps ----- //

/**
 * Wrap Region#segmentizeMovement to handle plateau/ramp/stairs/elevator
 * @param {RegionMovementWaypoint[]} waypoints    The waypoints of movement.
 * @param {Point[]} samples                       The points relative to the waypoints that are tested.
 *                                                Whenever one of them is inside the region, the moved object
 *                                                is considered to be inside the region.
 * @param {object} [options]                      Additional options
 * @param {boolean} [options.freefall=false]      Should elevation changes follow the ramp/plateau when moving down?
 * @returns {RegionMovementSegment[]}             The movement split into its segments.
 */
function segmentizeMovement(wrapper, waypoints, samples, { freefall = false, ...opts } = {}) {
  const segments = wrapper(waypoints, samples, opts);
  const numSegments = segments.length;
  if ( !numSegments ) return segments;

  // Determine if the region has a setElevation behavior.
  // For each behavior, adjust the segments to reflect the behavior.
  // TODO: Better handling if multiple behaviors found.
  for ( const behavior of this.document.behaviors ) {
    modifySegmentsForPlateau(segments, behavior, freefall);
    modifySegmentsForStairs(segments, behavior, freefall);
    modifySegmentsForRamp(segments, behavior, freefall);
  }
  return segments;
}

/**
 * Wrap Region#_draw
 * Modify hatch direction to match setElevation.
 */
async function _draw(wrapped, options) {
  wrapped(options);
  const mesh = this.children.find(c => c instanceof foundry.canvas.regions.RegionMesh);
  if ( !mesh ) return;

  // Must be defined for all region meshes.
  mesh.shader.uniforms.hatchThickness = canvas.dimensions.size / 10;
  this._refreshTerrainMapperMesh();
}


/*

      if ( insetPercentage != 0.0 ) {
        if ( percentFromBorder.x < insetPercentage || percentFromBorder.x > insetPercentage ) hatchOffset = vHatchVertical;
        if ( percentFromBorder.y < insetPercentage || percentFromBorder.y > insetPercentage ) hatchOffset = vHatchHorizontal;

        if ( percentFromBorder.x < insetPercentage && percentFromBorder.y < insetPercentage ) {
          if ( percentFromBorder.x < percentFromBorder.y ) hatchOffset = vHatchVertical;
          else hatchOffset = vHatchHorizontal;
        }

        if ( percentFromBorder.x > insetPercentage && percentFromBorder.y > insetPercentage ) {
          if ( percentFromBorder.x < percentFromBorder.y ) hatchOffset = vHatchVertical;
          else hatchOffset = vHatchHorizontal;
        }
      }

region = canvas.regions.placeables[0]
mesh = region.children.find(c => c instanceof foundry.canvas.regions.RegionMesh);
thicknessMultiplier = 2
hatchThickness = canvas.dimensions.size / 10
border = region.getBounds()
border.s = border.left
border.t = border.top
border.p = border.right
border.q = border.bottom


xPercent = .5
yPercent = 0

pixelCoord = { x: border.right + (border.left - border.right) * xPercent, y: border.top + (border.bottom = border.top) * yPercent }
hatchX = 1
hatchY = 0
percentR = ((pixelCoord.x - border.s) / (border.p - border.s));
percentT = ((pixelCoord.y - border.t) / (border.q - border.t));
stripeThickness = hatchThickness * Math.pow(thicknessMultiplier, (percentR * hatchX) + (percentT * hatchY));
console.log(`R: ${percentR} * ${hatchX} = ${percentR * hatchX}\tT: ${percentT} * ${hatchY} = ${percentT * hatchY}\tthickness: ${stripeThickness}`)
*/



/**
 * Calculate the hatch X and Y based on the direction of the ramp.'
 * Stripe represents where elevation is equal across the shape.
 * @param {number} direction  Direction, in degrees, between 0º and 359º
 * @returns {object}
 * - @prop {number} hatchX
 * - @prop {number} hatchY
 */
function calculateHatchXY(direction) {
  // hatchX = 1, hatchY = 0: vertical stripes.
  // hatchX = 0, hatchY = 1: horizontal stripes.
  // hatchX === hatchY: 45º stripes, running SW to NE
  // hatchX = -1, hatchY = 1: 45º stripes, running NW to SE
  // hatchX = .3, hatchY = .7: ~ 30º, SW to NE
  // hatchX = .7, hatchY = .3: ~ 60º, SW to NE
  // Going larger than 1 shrinks the stripe width
  // 0º direction should be due south, so horizontal stripes.
  // 0º: hatchX = 0, hatchY = 1  // Due south; horizontal stripes
  //
  // 45º: hatchX = -.5, hatchY = .5
  //
  // 90º: hatchX = -1, hatchY = 0 // Due west; vertical stripes
  // 45º: hatchX = .5, hatchY = .5

  if ( direction <= 90 ) {
    const t0 = direction / 90;
    return { hatchX: -t0, hatchY: 1 - t0 };
  } else if ( direction <= 180 ) {
    const t0 = (direction - 90) / 90;
    return { hatchX: 1 - t0, hatchY: t0 };
  } else if ( direction <= 270 ) {
    const t0 = (direction - 180) / 90;
    return { hatchX: t0, hatchY: t0 - 1 };
  } else if ( direction <= 360 ) {
    const t0 = (direction - 270) / 90;
    return { hatchX: t0 - 1, hatchY: -t0 };
  }

  /* Test with
  0, 30, 45, 60, 90,
   120, 135, 150, 180
   210, 225, 240, 270
   300, 315, 330, 360

  res = calculateHatchXY(0)
  mesh.shader.uniforms.hatchX = res.hatchX;
  mesh.shader.uniforms.hatchY = res.hatchY;
  */

}

/**
 * Wrap Region._applyRenderFlags
 * Apply the terrain mapper mesh modifications.
 */
function _applyRenderFlags(wrapper, flags) {
  wrapper(flags);
  if ( flags.refreshTerrainMapperMesh ) this._refreshTerrainMapperMesh();
}


PATCHES.REGIONS.WRAPS = { segmentizeMovement, _draw, _applyRenderFlags};


// ----- NOTE: Methods ----- //

/**
 * Region._refreshTerrainMapperMesh
 * Update the mesh uniforms for setElevation behavior
 */
function _refreshTerrainMapperMesh() {
  const mesh = this.children.find(c => c instanceof foundry.canvas.regions.RegionMesh);
  if ( !mesh ) return;

  let hatchThickness = canvas.dimensions.size / 10;
  mesh.shader.uniforms.hatchThickness = hatchThickness; // Must be defined for all region meshes.

  // Get the first setElevation behavior.
  const behavior = this.document.behaviors.find(b => b.type === `${MODULE_ID}.setElevation` && !b.disabled);
  if ( !behavior ) return;

  // insetPercentage: Rectangular edge portion. 0.5 covers the entire space (inset from region border on each side).
  // hatchX, hatchY: Controls direction of the hatching except for the inset border.
  // insetBorderThickness: Separate control over the inset border hatching.

  const { PLATEAU, STAIRS, RAMP } = FLAGS.REGION.CHOICES;
  let hatchX = 1;
  let hatchY = 1;
  let insetPercentage = 0;
  let insetBorderThickness = hatchThickness;
  switch ( behavior.system.algorithm ) {
    case PLATEAU: {
      // Set a striped inset border.
      // Inside the border is solid.
      insetPercentage = 0.1;
      hatchThickness = 0;
      break;
    }

    case STAIRS: {
      // Horizontal stripes along the entirety
      hatchX = 0;
      hatchY = 1;
      break;
    }

    case RAMP: {
      // Set a striped inset border.
      // Direction stripes within the border.
      insetPercentage = 0.1;
      const res = calculateHatchXY(behavior.system.rampDirection);
      hatchX = res.hatchX;
      hatchY = res.hatchY;
      break;
    }
  }

  const { left, top, right, bottom } = this.bounds;
  mesh.shader.uniforms.border = [left, top, right, bottom];
  mesh.shader.uniforms.hatchX = hatchX;
  mesh.shader.uniforms.hatchY = hatchY;
  mesh.shader.uniforms.hatchThickness = hatchThickness;
  mesh.shader.uniforms.insetPercentage = insetPercentage;
  mesh.shader.uniforms.insetBorderThickness = insetBorderThickness
}

PATCHES.REGIONS.METHODS = { _refreshTerrainMapperMesh };


// ----- NOTE: Helper functions ----- //

/* Plateau
Treat the plateau as mostly a hard obstacle.
Entry from top: stay at the plateau elevation.
Entry from side: stay at the plateau elevation.

Only way to be "inside" the plateau is to enter from the bottom or do a move once on top.

Track whether we are outside or inside the region.
Every time we move from outside --> in,
  - Add vertical move up.
  - change all subsequent inside ("move") points to the elevation.
Every time we move inside --> out
  - If reset, add drop to ground unless the segment has elevation; do not adjust subsequent points.
  - If not reset and at plateau elevation, adjust subsequent points.

Technically, it may be possible for a change in plateau to require a re-do of the segmentized path.
But not practically at the moment b/c all region shapes have the same shape as they move up in elevation.
*/

/**
 * Adjust region movement segments for the setElevation plateau behavior.
 * A plateau forces segments that cross into the region to be at elevation, along with
 * all segment points within the region. Starting within does not count.
 * @param {RegionMovementSegment[]} segments
 * @param {RegionBehavior} behavior
 */
function modifySegmentsForPlateau(segments, behavior, freefall = false) {
  if ( behavior.type !== `${MODULE_ID}.setElevation` || behavior.disabled || behavior.system.algorithm !== FLAGS.REGION.CHOICES.PLATEAU ) return segments;
  const { elevation, reset } = behavior.system;
  const { ENTER, MOVE, EXIT } = Region.MOVEMENT_SEGMENT_TYPES;
  const terrainFloor = canvas.scene?.getFlag(MODULE_ID, FLAGS.SCENE.BACKGROUND_ELEVATION) ?? 0;

  let entered = false;
  for ( let i = 0, n = segments.length; i < n; i += 1 ) {
    const segment = segments[i];
    if ( !segment ) { console.warn("segment not defined!"); continue; }
    switch ( segment.type ) {
      case ENTER: {
        entered = true;

        // If already at elevation, we are finished.
        if ( elevation === segment.to.elevation ) break;

        // Add a vertical move up after the enter.
        const vSegment = constructVerticalMoveSegment(segment.to, elevation);
        segments.splice(i + 1, 0, vSegment);
        i += 1;
        n += 1;
        break;
      }
      case MOVE: {
        // If we entered, subsequent move should be set to the elevation.
        if ( entered ) {
          segment.from.elevation = Math.max(elevation, segment.from.elevation);
          segment.to.elevation = Math.max(elevation, segment.to.elevation);
          break;
        }

        // Did not enter.
        // If freefalling and moving down through the plateau and freefalling, add the intersect point to the segments.
        // This will cause a downward movement to stop at the plateau and then move horizontally.
        if ( freefall && segment.from.elevation > elevation && segment.to.elevation < elevation ) {
          const ix = regionWaypointsXYEqual(segment.from, segment.to)
            ? { ...segment.from, elevation }
              : behavior.system.plateauSegmentIntersection(segment.from, segment.to);
          if ( ix ) {
            if ( regionWaypointsEqual(ix, segment.from) || regionWaypointsEqual(ix, segment.to) ) break;

            // Replace this segment with from --> ix --> to
            const toIx = { type: MOVE, from: segment.from, to: ix };
            const fromIx = { type: MOVE, from: ix, to: segment.to };
            segments.splice(i, 1, toIx, fromIx);
            n += 1;
            break;
          }
        }
        break;
      }
      case EXIT: {
        if ( !reset ) { entered = false; break; }

        // If entered and on the plateau elevation, reset to terrain elevation.
        // If freefall, reset to the terrain elevation.
        if ( !(freefall || (entered && elevation !== segment.from.elevation)) ) { entered = false; break; }
        entered = false;

        // Add vertical move down to terrain elevation if not already there.
        const numAdded = insertVerticalMoveToTerrainFloor(i, segments, terrainFloor);
        i += numAdded;
        n += numAdded;
        break;
      }
    }
  }
  return segments;
}

/**
 * Adjust region movement segments for the setElevation stairs behavior.
 * On entry, if elevation is ≤ halfway between top/floor, then move to top elevation.
 * Otherwise move to floor.
 * No reset when exiting.
 * Does nothing if already within the region; only on entry.
 * @param {RegionMovementSegment[]} segments
 * @param {RegionBehavior} behavior
 */
function modifySegmentsForStairs(segments, behavior) {
  if ( behavior.type !== `${MODULE_ID}.setElevation` || behavior.disabled || behavior.system.algorithm !== FLAGS.REGION.CHOICES.STAIRS ) return segments;
  const { elevation, floor, reset } = behavior.system;
  const { ENTER, MOVE, EXIT } = Region.MOVEMENT_SEGMENT_TYPES;
  const midE = Math.round((elevation - floor) * 0.5); // ≤ midE: go up; > midE: go down.
  const terrainFloor = canvas.scene?.getFlag(MODULE_ID, FLAGS.SCENE.BACKGROUND_ELEVATION) ?? 0;

  let entered = false;
  let up = true;
  let targetElevation = elevation;
  for ( let i = 0, n = segments.length; i < n; i += 1 ) {
    const segment = segments[i];
    if ( !segment ) continue;
    switch ( segment.type ) {
      case ENTER: {
        entered = true;
        up = segment.from.elevation <= midE;
        targetElevation = up ? elevation : floor;
        break;
      }
      case MOVE: {
        if ( !entered ) break;
        const cmpFn = up ? Math.max : Math.min;
        segment.from.elevation = cmpFn(targetElevation, segment.from.elevation);
        segment.to.elevation = cmpFn(targetElevation, segment.to.elevation);
        break;
      }
      case EXIT: {
        if ( !(entered || elevation === segment.from.elevation || floor === segment.from.elevation) ) break;
        entered = false;
        if ( !reset ) break;

        // Add vertical move down to terrain elevation if not already there.
        const numAdded = insertVerticalMoveToTerrainFloor(i, segments, terrainFloor);
        i += numAdded;
        n += numAdded;
        break;
      }
    }
  }
  return segments;
}

/**
 * Adjust region movement segments for the setElevation ramp behavior.
 * Just like plateau, except the surface inclines in a given direction.
 * Does nothing if already within the region; only on entry.
 *
 * @param {RegionMovementSegment[]} segments
 * @param {RegionBehavior} behavior
 */
function modifySegmentsForRamp(segments, behavior, freefall) {
  if ( behavior.type !== `${MODULE_ID}.setElevation` || behavior.disabled || behavior.system.algorithm !== FLAGS.REGION.CHOICES.RAMP ) return segments;
  const { reset } = behavior.system;
  const { ENTER, MOVE, EXIT } = Region.MOVEMENT_SEGMENT_TYPES;
  const terrainFloor = canvas.scene?.getFlag(MODULE_ID, FLAGS.SCENE.BACKGROUND_ELEVATION) ?? 0;

  let entered = false;
  for ( let i = 0, n = segments.length; i < n; i += 1 ) {
    const segment = segments[i];
    if ( !segment ) continue;

    switch ( segment.type ) {
      case ENTER: {
        entered = true;

        // If already at elevation, we are finished.
        const elevation = behavior.system.plateauElevation(segment.to);
        if ( elevation === segment.to.elevation ) break;

        // Add a vertical move up after the enter.
        const vSegment = constructVerticalMoveSegment(segment.to, elevation);
        segments.splice(i + 1, 0, vSegment);
        i += 1;
        n += 1;
        break;
      }
      case MOVE: {
        const currRampElevation = behavior.system.plateauElevation(segment.from);

        // Entered or currently at the ramp elevation; adjust the subsequent ramp elevation.
        if ( entered || segment.from.elevation.almostEqual(currRampElevation) ) {
          segment.from.elevation = currRampElevation;
          segment.to.elevation = behavior.system.plateauElevation(segment.to);
          break;
        }

        // Did not enter.
        // Adjust moves that intersect the ramp.
        // Unless using freefall, only horizontal moves count.
        if ( !(freefall || segment.from.elevation === segment.to.elevation) ) break;

        // Determine where the segment intersects the ramp.
        const ix = behavior.system.plateauSegmentIntersection(segment.from, segment.to);
        if ( !ix ) break;
        if ( regionWaypointsEqual(ix, segment.from) || regionWaypointsEqual(ix, segment.to) ) break;
        // if ( !this.testPoint(ix) ) break; // Skip because by definition, an intersection with the move segment will be within the region?

        // Replace this segment with from --> ix --> to
        const toIx = { type: MOVE, from: segment.from, to: ix };
        const fromIx = { type: MOVE, from: ix, to: segment.to };
        segments.splice(i, 1, toIx, fromIx);
        n += 1;
        break;
      }
      case EXIT: {
        if ( !reset ) { entered = false; break; }

        // If entered and on the ramp elevation, reset to terrain elevation.
        // If freefall, reset to the terrain elevation.
        if ( !(freefall || (entered && behavior.system.plateauElevation(segment.from) !== segment.from.elevation)) ) { entered = false; break; }
        entered = false;

        // Add vertical move down to terrain elevation if not already there.
        const numAdded = insertVerticalMoveToTerrainFloor(i, segments, terrainFloor);
        i += numAdded;
        n += numAdded;
        break;
      }
    }
  }
  return segments;
}

/**
 * Insert a vertical move down to the terrain floor
 * @param {number} i                            The index of the current segment
 * @param {RegionMovementSegment[]} segments    Segments for this path
 * @param {number} floor                        Elevation we are moving to
 */
function insertVerticalMoveToTerrainFloor(i, segments, floor) {
  const segment = segments[i];
  segment.from.elevation = floor;
  segment.to.elevation = floor;

  // If the previous segment is not at reset elevation, add vertical move (down)
  const prevSegment = segments[i - 1] ?? { to: segment.from }; // Use this segment's from if no previous segment.
  if ( prevSegment && prevSegment.to.elevation !== floor ) {
    const vSegment = constructVerticalMoveSegment(prevSegment.to, floor);
    segments.splice(i, 0, vSegment);
    return 1;
  }
  return 0;
}


/**
 * Construct a vertical move segment.
 * @param {RegionWaypoint} waypoint
 * @param {number} targetElevation
 * @returns {RegionMoveSegment}
 */
function constructVerticalMoveSegment(waypoint, targetElevation) {
  return {
    from: {
      x: waypoint.x,
      y: waypoint.y,
      elevation: waypoint.elevation
    },
    to: {
      x: waypoint.x,
      y: waypoint.y,
      elevation: targetElevation
    },
    type: Region.MOVEMENT_SEGMENT_TYPES.MOVE
  };
}


/**
 * Rotate a polygon a given amount clockwise, in radians.
 * @param {PIXI.Polygon} poly   The polygon
 * @param {number} rotation     The amount to rotate clockwise in radians
 * @param {number} [centroid]   Center of the polygon
 */
function rotatePolygon(poly, rotation = 0, centroid) {
  if ( !rotation ) return poly;
  centroid ??= poly.center;

  // Translate to 0,0, rotate, translate back based on centroid.
  const rot = Matrix.rotationZ(rotation, false)
  const trans = Matrix.translation(-centroid.x, -centroid.y);
  const revTrans = Matrix.translation(centroid.x, centroid.y);
  const M = trans.multiply3x3(rot).multiply3x3(revTrans);

  // Multiply by the points of the polygon.
  const nPoints = poly.points.length * 0.5
  const arr = new Array(nPoints);
  for ( let i = 0; i < nPoints; i += 1 ) {
    const j = i * 2;
    arr[i] = [poly.points[j], poly.points[j+1], 1];
  }
  const polyM = new Matrix(arr);
  const rotatedM = polyM.multiply(M);

  const rotatedPoints = new Array(poly.points.length);
  for ( let i = 0; i < nPoints; i += 1 ) {
    const j = i * 2;
    rotatedPoints[j] = rotatedM.arr[i][0];
    rotatedPoints[j+1] = rotatedM.arr[i][1];
  }
  return new PIXI.Polygon(rotatedPoints)
}

/**
 * Locate the minimum/maximum points of a polygon along a given axis.
 * E.g., if the axis is from high to low y (due north), the points would be min: maxY, max: minY.
 * @param {PIXI.Polygon} poly         The polygon
 * @param {number} [direction=0]      The axis direction, in degrees. 0º is S, 90º is W
 * @param {number} [centroid]         Center of the polygon
 * @returns {object}
 * - @prop {Point} min    Where polygon first intersects the line orthogonal to direction, moving in direction
 * - @prop {Point} max    Where polygon last intersects the line orthogonal to direction, moving in direction
 */
function minMaxPolygonPointsAlongAxis(poly, direction = 0, centroid) {
  centroid ??= poly.center;
  if ( direction % 90 ) {
    // Rotate the polygon to direction 0 (due south).
    const rotatedPoly = rotatePolygon(poly, Math.toRadians(360 - direction), centroid);
    const bounds = rotatedPoly.getBounds();

    // Rotate back
    const minMaxRotatedPoly = new PIXI.Polygon(centroid.x, bounds.top, centroid.x, bounds.bottom);
    const minMaxPoly = rotatePolygon(minMaxRotatedPoly, -Math.toRadians(360 - direction), centroid);
    return { min: { x: minMaxPoly.points[0], y: minMaxPoly.points[1] }, max: { x: minMaxPoly.points[2], y: minMaxPoly.points[3] } };
  }

  // Tackle the simple cases.
  const bounds = poly.getBounds();
  switch ( direction ) {
    case 0: return { min: { x: centroid.x, y: bounds.top }, max: { x: centroid.x, y: bounds.bottom } }; // Due south
    case 90: return { min: { x: bounds.right, y: centroid.y }, max: { x: bounds.left, y: centroid.y } }; // Due west
    case 180: return { min: { x: centroid.x, y: bounds.bottom }, max: { x: centroid.x, y: bounds.top } }; // Due north
    case 270: return { min: { x: bounds.left, y: centroid.y }, max: { x: bounds.right, y: centroid.y } }; // Due east
  }
}

/*
Draw = CONFIG.GeometryLib.Draw
api = game.modules.get("terrainmapper").api
minMaxRegionPointsAlongAxis = api.minMaxRegionPointsAlongAxis

region = canvas.regions.placeables[0]
minMax = minMaxRegionPointsAlongAxis(region, 0)
Draw.segment({ A: minMax.min, B: minMax.max});
Draw.point(minMax.max)

[behavior] = region.document.behaviors
minMax = behavior.flags.terrainmapper.minMax
*/

/**
 * Determine the minimum/maximum points of a region along a give axis.
 * @param {Region} region             The region to measure
 * @param {number} [direction=0]      The axis direction, in degrees. 0º is S, 90º is W
 * @returns {object}
 * - @prop {Point} min    Where region first intersects the line orthogonal to direction, moving in direction
 * - @prop {Point} max    Where region last intersects the line orthogonal to direction, moving in direction
 */
export function minMaxRegionPointsAlongAxis(region, direction = 0) {
  // By definition, holes cannot be the minimum/maximum points.
  const polys = region.polygons.filter(poly => poly._isPositive);
  const nPolys = polys.length;
  if ( !nPolys ) return undefined;

  // For consistency (and speed), rotate the bounds of the region.
  const center = region.bounds.center;
  const minMax = minMaxPolygonPointsAlongAxis(polys[0], direction, center);
  minMax.min._dist2 = PIXI.Point.distanceSquaredBetween(minMax.min, center);
  minMax.max._dist2 = PIXI.Point.distanceSquaredBetween(minMax.max, center);
  for ( let i = 1; i < nPolys; i += 1 ) {
    const res = minMaxPolygonPointsAlongAxis(polys[i], direction, center);

    // Find the point that is further from the centroid.
    res.min._dist2 = PIXI.Point.distanceSquaredBetween(minMax.min, center);
    res.max._dist2 = PIXI.Point.distanceSquaredBetween(minMax.max, center);
    if ( res.min._dist2 > minMax.min._dist2 ) minMax.min = res.min;
    if ( res.max._dist2 > minMax.max._dist2 ) minMax.max = res.max;
  }
  return minMax;
}