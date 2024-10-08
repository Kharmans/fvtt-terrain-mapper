/* globals
CONST,
foundry
*/
/* eslint no-unused-vars: ["error", { "argsIgnorePattern": "^_" }] */
"use strict";

import { MODULE_ID, MODULES_ACTIVE } from "../const.js";
import { log } from "../util.js";
import { ElevationHandler } from "../ElevationHandler.js";
import { continueTokenAnimationForBehavior } from "./StairsRegionBehaviorType.js";

export const PATCHES = {};
PATCHES.REGIONS = {};


/**
 * @typedef RegionPathWaypoint extends RegionMovementWaypoint
 * RegionMovementWaypoint with added features to describe its position along a segment and the regions encountered
 * @prop {object} regions
 *   - @prop {Set<Region>} enter    All regions entered at this location;
 *                                  the region contains this point but not the previous
 *   - @prop {Set<Region>} exit     All regions exited at this location;
 *                                  the region contains this point but not the next
 *   - @prop {Set<Region>} move     All regions were already entered at the start
 * @prop {number} dist2             Distance squared to the start
 * @prop {RegionMovementWaypoint} start   Starting waypoint
 */

/**
 * Region behavior set the elevation of a token based on multiple elevation options.
 * @property {Set<>}
 * @property {FLAGS.REGION.CHOICES} algorithm       How elevation change should be handled. plateau, ramp, stairs
 */
export class ElevatorRegionBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
  static defineSchema() {
    const fields = foundry.data.fields;
    const setFieldOptions = {
      label: `${MODULE_ID}.phrases.elevator`,
      hint: `${MODULE_ID}.behavior.types.elevator.fields.floors.hint`
    };

    return {
      floors: new fields.SetField(new fields.StringField({}), setFieldOptions),
      /* Will not display (see BaseActiveEffect for parallel example):
      floors: new fields.ArrayField(new fields.SchemaField({
        elevation: new fields.NumberField({ required: true }),
        label: new fields.StringField(),
      }), setFieldOptions),
      */

      strict: new fields.BooleanField({
        label: `${MODULE_ID}.behavior.types.elevator.fields.strict.name`,
        hint: `${MODULE_ID}.behavior.types.elevator.fields.strict.hint`,
        initial: false
      }),

      resetOnExit: new foundry.data.fields.BooleanField({
        label: `${MODULE_ID}.behavior.types.elevator.fields.resetOnExit.name`,
        hint: `${MODULE_ID}.behavior.types.elevator.fields.resetOnExit.hint`,
        initial: false
      }),
    };
  }

  /** @override */
  static events = {
    [CONST.REGION_EVENTS.TOKEN_MOVE_IN]: this.#onTokenMoveIn,
    [CONST.REGION_EVENTS.TOKEN_MOVE_OUT]: this.#onTokenMoveOut,
    [CONST.REGION_EVENTS.TOKEN_PRE_MOVE]: this.#onTokenPreMove,
  };

  /**
   * @type {RegionEvent} event
   *   - @prop {object} data        Data related to the event
   *   - @prop {Token} token      Token triggering the event
   *   - @prop {string} name        Name of the event type (e.g., "tokenEnter")
   *   - @prop {RegionDocument}     Region for the event
   *   - @prop {User} user          User that triggered the event
   */
  static async #onTokenMoveIn(event) {
    const data = event.data;
    log(`Token ${data.token.name} moving into ${event.region.name}!`);
    if ( event.user !== game.user ) return;
    const tokenD = data.token;
    const { stops, elevations } = this.getStopsAndElevations();

    // When strict, don't trigger the elevator unless the token is already on a floor.
    let takeElevator = !this.strict || elevations.has(tokenD.elevation);
    let chosenElevation;

    // Ask the user to pick a floor.
    if ( takeElevator ) {
      const window = { title: game.i18n.localize(`${MODULE_ID}.phrases.elevator`) };
      let content = "";
      for ( const stop of stops ) {
        const floorLabel = Object.keys(stop)[0];
        const floorElev = stop[floorLabel];
        const checked = tokenD.elevation.almostEqual(floorElev) ? "checked" : "";
        content += `\n<label><input type="radio" name="choice" value=" ${floorElev}" ${checked}>${floorLabel}</label>`;
      }
      const buttons = [{
        action: "choice",
        label: game.i18n.localize(`${MODULE_ID}.phrases.elevator-choice`),
        default: true,
        callback: (event, button, _dialog) => button.form.elements.choice.value
      }];
      const res = await foundry.applications.api.DialogV2.wait({ rejectClose: false, window, content, buttons });
      chosenElevation = Number(res);

      // Update the elevation.
      takeElevator = res != null && chosenElevation !== tokenD.elevation;
    }

    // Execute either the elevator elevation move or continue the 2d move.
    await continueTokenAnimationForBehavior(this, tokenD, takeElevator ? chosenElevation : undefined);
  }

  /**
   * @type {RegionEvent} event
   *   - @prop {object} data        Data related to the event
   *    - @prop {Token} token      Token triggering the event
   *   - @prop {string} name        Name of the event type (e.g., "tokenEnter")
   *   - @prop {RegionDocument}     Region for the event
   *   - @prop {User} user          User that triggered the event
   */
  static async #onTokenMoveOut(event) {
    const data = event.data;
    log(`Token ${data.token.name} moving out of ${event.region.name}!`);
    if ( event.user !== game.user ) return;
    const tokenD = data.token;
    const groundElevation = ElevationHandler.sceneFloor;
    const { elevations } = this.getStopsAndElevations();

    // When strict, don't trigger the elevator unless the token is already on a floor.
    let resetToGround = this.resetOnExit
      && tokenD.elevation !== groundElevation
      && (!this.strict || elevations.has(tokenD.elevation));

    // Confirm with user.
    if ( resetToGround ) {
      const content = game.i18n.localize(`${MODULE_ID}.phrases.resetOnExit`);
      resetToGround = await foundry.applications.api.DialogV2.confirm({ content, rejectClose: false, modal: true });
    }

    // Either change the elevation to reset to ground or continue the 2d move.
    await continueTokenAnimationForBehavior(this, tokenD, resetToGround ? groundElevation : undefined);
  }

  /** @type {RegionWaypoint} */
  static lastDestination;

  /**
   * Stop at the entrypoint for the region.
   * This allows onTokenEnter to then handle the stair movement.
   * @param {RegionEvent} event
   * @this {PauseGameRegionBehaviorType}
   */
  static async #onTokenPreMove(event) {
    if ( event.data.forced ) return;

    for ( const segment of event.data.segments ) {
      if ( segment.type === Region.MOVEMENT_SEGMENT_TYPES.ENTER ) {
        this.constructor.lastDestination = event.data.destination;
        event.data.destination = segment.to;
        break;
      }
    }

    if ( this.resetOnExit ) {
      for ( const segment of event.data.segments ) {
        if ( segment.type === Region.MOVEMENT_SEGMENT_TYPES.EXIT ) {
          this.constructor.lastDestination = event.data.destination;
          event.data.destination = segment.to;
          break;
        }
      }
    }
  }

  /**
   * Retrieve the stops and elevations for the floors of this behavior
   */
  getStopsAndElevations() {
    const stops = [];
    const elevations = new Set();
    this.floors.forEach(floor => {
      let [floorElev, floorLabel] = floor.split("|");
      floorLabel ??= floorElev.trim();
      floorElev = Number(floorElev);
      floorLabel = floorLabel.trim();
      stops.push({ [floorLabel]: floorElev }); // Use the labels as keys so that multiple labels can go to the same place.
      elevations.add(floorElev);
    });
    stops.sort((a, b) => b[Object.keys(b)[0]] - a[Object.keys(a)[0]]); // Sort on elevation low to high
    return { elevations, stops };
  }
}

/**
 * Hook preCreateRegionBehavior
 * Set the default elevation to the region top and bottom elevations if defined.
 * @param {Document} document                     The pending document which is requested for creation
 * @param {object} data                           The initial data object provided to the document creation request
 * @param {Partial<DatabaseCreateOperation>} options Additional options which modify the creation request
 * @param {string} userId                         The ID of the requesting user, always game.user.id
 * @returns {boolean|void}                        Explicitly return false to prevent creation of this Document
 */
function preCreateRegionBehavior(document, data, _options, _userId) {
  log("preCreateRegionBehavior");
  if ( data.type !== `${MODULE_ID}.elevator` ) return;
  const topE = document.region.elevation.top;
  const bottomE = document.region.elevation.bottom ?? ElevationHandler.sceneFloor;
  const bottomLabel = game.i18n.localize(`${MODULE_ID}.phrases.bottom`);
  const topLabel = game.i18n.localize(`${MODULE_ID}.phrases.top`);

  const floors = [`${bottomE}|${bottomLabel}`];
  if ( topE ) floors.push(`${topE}|${topLabel}`);
  document.updateSource({ "system.floors": floors });
}

PATCHES.REGIONS.HOOKS = { preCreateRegionBehavior };

