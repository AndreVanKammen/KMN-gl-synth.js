// Copyright by André van Kammen
// Licensed under CC BY-NC-SA 
// https://creativecommons.org/licenses/by-nc-sa/4.0/

import { emptyFloat64Array } from "./stream-buffer.js";
import { SynthNote } from "./webgl-synth-data.js";

class SampleBuffer {
  /**
   * 
   * @param {number} capacity 
   */
  constructor(capacity) {
    this.capacity = capacity;
    this.leftSamples = new Float32Array(this.capacity);
    this.rightSamples = new Float32Array(this.capacity);
  }
}

export class SampleData {
  /**
   * @param {SampleBuffer} sampleBuffer
   * @param {number} sampleOffset
   * @param {number} sampleLength
   */
  constructor(sampleBuffer, sampleOffset = 0, sampleLength = 0) {
    this.sampleBuffer = sampleBuffer;
    this._sampleOffset = sampleOffset;
    this._sampleLength = sampleLength;
    /** @type {Float32Array} */
    this._leftSamples = null;
    /** @type {Float32Array} */
    this._rightSamples = null;
  }

  get sampleOffset() {
    return this._sampleOffset
  }

  set sampleOffset(x) {
    if (this._sampleOffset !== x) {
      this._sampleOffset = x;
      this._leftSamples = null;
      this._rightSamples = null;
    }
  }

  get sampleLength() {
    return this._sampleLength;
  }

  set sampleLength(x) {
    if (this._sampleLength !== x) {
      this._sampleLength = x;
      this._leftSamples = null;
      this._rightSamples = null;
    }
  }

  get leftSamples() {
    if (!this._leftSamples) {
      this._leftSamples = this.sampleBuffer.leftSamples.subarray(this.sampleOffset, this.sampleOffset + this.sampleLength);
    }
    return this._leftSamples;
  }

  get rightSamples() {
    if (!this._rightSamples) {
      this._rightSamples = this.sampleBuffer.rightSamples.subarray(this.sampleOffset, this.sampleOffset + this.sampleLength);
    }
    return this._rightSamples;
  }
}

export class SampleBank {
  /**
   * Creates a placeholder for a list of audio tracks and the analysis of it
   */
  constructor(capacity) {
    this.sampleBuffer = new SampleBuffer(capacity);
    /** @type {Array<SampleData>} */
    this.tracks = [];
  }

  /**
   * @param {SynthNote} noteEntry
   */
   getData(noteEntry) {
    let sampleData = this.tracks[noteEntry.note % this.tracks.length];
    return {
      left: sampleData?.leftSamples || emptyFloat64Array,
      right: sampleData?.rightSamples || emptyFloat64Array
    }
  }

  /**
   * Remove track from list
   * @param {number} trackIndex The index returned on add
   */
  removeTrack(trackIndex) {
    this.tracks[trackIndex] = null;
  }
}
