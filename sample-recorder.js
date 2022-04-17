import { SampleBank } from "./sample-bank.js";
import { SynthMixer } from "./webgl-synth-data.js";

export class SampleRecorder extends SampleBank {
  /**
   * 
   * @param {SynthMixer} mixer 
   * @param {number} capacity 
   */
  constructor(mixer, capacity) {
    super(capacity);
    this.mixer = mixer;
  }

  /**
   * @param {any[]} buffer
   * @param {number} streamNr
   * @param {number} trackNr
   * @param {number} streamFloatSize
   * @param {any} bufferOffset
   * @param {any} startSampleNr
   * @param {number} count
   */
  getData(buffer, streamNr, trackNr, streamFloatSize, bufferOffset, startSampleNr, count) {
    return super.getData(buffer, streamNr, trackNr, streamFloatSize, bufferOffset, startSampleNr, count);
  }

}