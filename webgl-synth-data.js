// Copyright by André van Kammen
// Licensed under CC BY-NC-SA 
// https://creativecommons.org/licenses/by-nc-sa/4.0/

import defer from '../KMN-utils.js/defer.js';
import { otherControls } from './otherControls.js';
import { StreamBuffer } from './stream-buffer.js';
import { TrackLineInfo } from './webgl-memory-manager.js';
import { SynthExecutePlanner } from './webgl-synth-execute-plan.js';
import WebGLSynth from './webgl-synth.js';

const maxNoteLength = 1.5 * 3600.0;
const maxControlCount = 1024;
// TODO in the case of notes, silence could also end the note, but that is only known at play time
// TODO this extra time can be calculated from decayTime + max(effectsTime)
const extraAfterRelease = 4.5; // Give it an extra time to fade out in seconds after release

// const streamingTrackData = {
//   time: 0,
//   note: 0,
//   releaseTime: 3600*24,
//   velocity: 1.0,
//   program: 2048
// }


export class ControlHandler {
  constructor (owner, timeZone) {
    this.owner = owner;
    // this.controls = [];
    this.controlChanges = {};
    this.timeZone = timeZone;

    this.controlLastUpdateTime = 0;
    this.controlBuffer = null;
    this.texInfo = { texture:undefined, size:0 };

    // TODO handle defaults trough ControlNames table in datamodel
    // Defaults for volume, expression, pan and balance
    this.controlDefaults = {};
    this.controlDefaults[7] = 1.0;
    this.controlDefaults[11] = 1.0;
    this.controlDefaults[8] = 0.5;
    this.controlDefaults[10] = 0.5;
  }


  addControl(time, controlType, value, interpolate = false) {
    // console.log('control ', controlType, value);
    let controlInfo = this.controlChanges[controlType];
    if (!controlInfo) {
      controlInfo = this.controlChanges[controlType] = {
        controlData: [], 
        interpolate};
    }
    controlInfo.controlData.push({time, value});
  }

  getControlAtTime(synthTime, controlType, defaultValue) {
    let controlInfo = this.controlChanges[controlType]
    if (defaultValue === undefined) {
      defaultValue = this.controlDefaults[controlType] || 0;
    } else {
      this.controlDefaults[controlType] = defaultValue;
    }

    if (!controlInfo) {
      return this.controlDefaults[controlType];
    }
    let changes = controlInfo.controlData;

    for (let ix = changes.length-1; ix >= 0; ix--) {
      let change = changes[ix];
      // TODO optimize convertTime can be calle once and incremented?
      let time = this.owner.convertTime(synthTime, change.time, this.timeZone);
      if (time <= synthTime) {
        if (controlInfo.interpolate && (ix<changes.length-1)) {
          let nextChange = changes[ix + 1];
          let nextVal = nextChange.value;
          let nextTime = this.owner.convertTime(synthTime, nextChange.time, this.timeZone);
          let deltaTime = (synthTime-time) / (nextTime - time);
          return change.value * (1.0-deltaTime) + deltaTime * nextVal;
        } else {
          return change.value;
        }
      }
    }
    return defaultValue;
  }

  updateControlBuffer(synthTime, bufferTime) {

    // TODO this means it is single use
    if ((this.controlLastUpdateTime === synthTime) && (!!this.controlBuffer)) {
      return false;
    }
    this.controlLastUpdateTime = synthTime;
    // Let's make a buffer with relevant info for the synth
    // x = lastValue
    // y = lastTime
    // z = newValue
    // w = newTime
    if (!this.controlBuffer) {
      this.controlBuffer = new Float32Array(maxControlCount * 4);
      // Different defaults
      // 7: 'Channel Volume',
      // 8: 'Balance',
      // 10: 'Pan',

      // TODO time is never used, so why are we passing it?
      //      my previous idea was to pass the change times 
      //      so the videocard can do the interpolation but that would need to be a setting
    
      for (let ctrl in this.controlDefaults) {
        let ctrlNr = ~~ctrl;
        let value = this.controlDefaults[ctrl];
        this.controlBuffer[ctrlNr * 4 + 0] = value;
        this.controlBuffer[ctrlNr * 4 + 1] = synthTime;
        this.controlBuffer[ctrlNr * 4 + 2] = value;
        this.controlBuffer[ctrlNr * 4 + 3] = synthTime + bufferTime;
      }
    } 
    for (let ctrl of Object.keys(this.controlChanges)) {
      let ctrlNr = ~~ctrl;
      // let value = this.controls[ctrl];
      if (ctrlNr === otherControls.pitch) {
        // Do not interpolate pitch it's the same for the whole block
        let value = this.getControlAtTime(synthTime, otherControls.pitch);
        this.controlBuffer[ctrlNr * 4 + 0] = value;
        this.controlBuffer[ctrlNr * 4 + 1] = synthTime;
        this.controlBuffer[ctrlNr * 4 + 2] = value;
        this.controlBuffer[ctrlNr * 4 + 3] = synthTime + bufferTime;
      } else {
        this.controlBuffer[ctrlNr * 4 + 0] = this.controlBuffer[ctrlNr * 4 + 2]; // from previous
        this.controlBuffer[ctrlNr * 4 + 1] = synthTime;
        this.controlBuffer[ctrlNr * 4 + 2] = this.getControlAtTime(synthTime + bufferTime, ctrlNr); // from the future
        this.controlBuffer[ctrlNr * 4 + 3] = synthTime + bufferTime;
      }
    }
    
    // Test to see if any value comes trough
    // for (let ix = 0; ix < this.controlBuffer.length; ix++) {
    //   this.controlBuffer[ix] = 123.456;
    // }
    return true;
  }
  
}
// Base for all audio handling classes here
export class SynthBaseEntry {
  /**
   * @param {SynthMixer} mixer 
   */
  constructor (mixer) {
    this.mixer = mixer;

    // For use in synth
    this.runHandled = false;

    /** @type {TrackLineInfo[]} */
    this.buffers = [];

    this.synth = null; // Is filled by the synth at process time

    this._finishResolvers = [];
  }

  async waitForFinished() {
    return new Promise((resolve) => {
       this._finishResolvers.push(resolve);
    });
  }

  /**
   * Updates the buffer allocations for the whole effect path within the mixer
   * @param {WebGLSynth} synth 
   * @param {SynthMixer} mixer 
   * @param {number} passNr 
   * @returns Last 
   */
  updateBuffers(synth, mixer, passNr) {
    if (mixer && (mixer.effects.length>0)) {
      while (this.buffers.length < (mixer.effects.length + 1)) {
        this.buffers.push(synth.memoryManager.getTrackLineInfo())
      }
      for (let ix = 0; ix < mixer.effects.length + 1; ix++) {
        let historyTime = 0.0;
        if (ix < mixer.effects.length) {
          historyTime = mixer.effects[ix].getHistoryTime();
        }

        let count = ~~Math.ceil(Math.max((historyTime + this.synth.bufferTime) / this.synth.bufferTime, 1));
        // Get (new) memory if necessary
        if (this.buffers[ix].updateAllocation(passNr, count)) {
        }
  
        this.buffers[ix].updateCurrent();
  
        passNr++;
      }
    } else {
      if (this.buffers.length===0) {
        this.buffers.push(synth.memoryManager.getTrackLineInfo())
      } else {
        for (let ix = 1; ix < this.buffers.length; ix++) {
          this.buffers[ix].freeBuffer();  
        }
        this.buffers = [this.buffers[0]];
      }
      if (this.buffers[0].updateAllocation(passNr, 1)) {
      }

      this.buffers[0].updateCurrent();
      passNr++;
    }
    return passNr;
  }

  dispose() {
    this.isFinished = true;
    if (this.synth) {
      for (let ix = 0; ix < this.buffers.length; ix++) {
        this.buffers[ix]
        let tli = this.buffers[ix]
        tli.freeBuffer();
      }
      this.buffers = [];
    }
    for (let resolver of this._finishResolvers) {
      resolver();
    }
    this._finishResolvers = [];
  }
}
export class SynthShaderInfo {
  constructor (shaderName, shaderSettings) {
    // this.trackLineInfo = new TrackLineInfo();
    this.shaderName = shaderName;
    this.shaderSettings = shaderSettings;
  }
}
class EffectShaderInfo extends SynthShaderInfo {
  constructor (effectName, effectSettings) {
    super(effectName, effectSettings)
  }
  getHistoryTime() {
    // TODO
    return 1.0;
    // return 0.16;
  }
}
class InputShaderInfo extends SynthShaderInfo {
  constructor (effectName, effectSettings) {
    super(effectName, effectSettings)
  }
}

class IAudioTracks {
  getData = (buffer, streamNr, trackNr, trackSize2, bufferOffset, startSampleNr, count) => {};
}
let mixerHash = 123;
export class SynthMixer extends SynthBaseEntry {
  constructor (mixer, inputShaderName) {
    super(mixer);
    this.inputShaderName = inputShaderName;
    /** @type {Array<EffectShaderInfo>} */
    this.effects = [];
    this.mixerHash = ++mixerHash;

    // For handling samples and audio tracks
    /** @type {StreamBuffer} */
    this.streamBuffer = null;
  }

  /**
   * Set's the sample/audiotracks for us by the shader
   * TODO rename playinput to plattrack
   *  @param {IAudioTracks} audioTracks 
   */
  setAudioStreams(audioTracks, synth) {
    // TODO: Move the buffer filling to the audiottrack implementation
    this.streamBuffer = new StreamBuffer(synth);
    // TODO: Every track can have it's own sampleRate or does decode fix that for us?
    // streamBuffer.sampleRate = audioData.sampleRate;
    // TODO: Consider other than stereo?
    this.divider = 0;
    this.audioTracks = audioTracks;
    this.streamBuffer.onGetData = audioTracks.getData.bind(audioTracks);
  }

  addEffect(name) {
    this.effects.push(
      new EffectShaderInfo(name, {}))
  }

  setEffects(effectShaders) {
    this.effects = [];
    for (let effectShader of effectShaders) {
      this.effects.push(
        new EffectShaderInfo(effectShader, {}))
    }
  }
}
class NoteData {
  note = ~~0;
  channel = ~~0;
  velocity = 1.0;
  audioOffset = 0.0;
}

// Base for playing notes trough the synth
export class SynthNote extends SynthBaseEntry {
  /**
   * 
   * @param {SynthPlayData} owner 
   * @param {number} time 
   * @param {string} timeZone 
   * @param {SynthMixer} mixer 
   * @param {Partial<NoteData>} data 
   * @param {ControlHandler} channelControl 
   */
  constructor (owner, time, timeZone, mixer, data, channelControl) {
    super(mixer);
    this.owner = owner;

    this.channel = data.channel;
    this.note = data.note;
    this.velocity = data.velocity;
    this.audioOffset = data.audioOffset || 0;
    this.streamNr = -1;
    this.time = 0;
    this.phaseTime = 0;

    this.timeZone = timeZone; // TimeZone's are used to sync the different input clocks to synthTime
    this.startTime = time;
    this.endTime = time + maxNoteLength + extraAfterRelease;

    this.timeVersion = 0;
    this.synthStart = 0.0;
    this.synthEnd = 0.0;
  
    this.isStarted = false;
    this.isFinished = false;

    this.releaseTime = maxNoteLength;
    this.channelControl = channelControl;

    this.lastSynthTime = 0.0;
    this.lastReleaseVelocity = 0.0;
    this.newReleaseVelocity = 0.0;
    this.lastAftertouch = 0.0;
    this.newAftertouch = 0.0;

    // For use in synth
    /** @type {TrackLineInfo[]} */
    this.runBuffers = [];
    this.runShaders = [];

    // this.isReleased = false;
    this.controlData = new ControlHandler(owner, timeZone);
    this.recordStartIndex = -1;
  }
  
  setRecordStart(index) {
    this.recordStartIndex = index
  }

  getPlayDirection(controlTime) {
    return this.channelControl.getControlAtTime(controlTime, otherControls.playDirection, 1.0);
  }
  
  release (time, velocity, releaseTime = extraAfterRelease) {
    if (velocity>=0) {
      this.controlData.addControl(time, otherControls.releaseVelocity, velocity);
    }

    this.endTime = time + releaseTime;
    this.releaseTime = time - this.startTime;
  }

  updateNoteControls(time) {
    if (this.lastSynthTime === time) {
      return;
    }
    this.lastSynthTime = time;

    this.lastReleaseVelocity = this.newReleaseVelocity;
    this.lastAftertouch = this.newAftertouch;
    this.newReleaseVelocity = this.controlData.getControlAtTime(time, otherControls.releaseVelocity,1.0);
    this.newAftertouch = this.controlData.getControlAtTime(time, otherControls.aftertouch,1.0);
  }

  changeControl (time, controlType, value, interpolate = false) {
    this.controlData.addControl(time, controlType, value, interpolate);
  }
}

class SynthPlayData {
  constructor (synth) {
   
    /** @type {WebGLSynth} */
    this.synth = synth;

    this.startIx = 0;
    this.timeOffsets = {};

    this.output = new SynthMixer(null);
    // this.output.addEffect('

    /** @type {Record<number, ControlHandler>} */
    this.channelControls = {};

    this.executePlanner = new SynthExecutePlanner(this);
    this.invalidateSceduled = false;
    /** @type {Map<Object,number>}*/
    this.callbacks = new Map();

    this.clear();
    // 1.587.600.000
  }

  clear() {
    if (this.entries) {
      for (let entry of this.entries) {
        if (!entry.isFinished) {
          entry.dispose()
        }
      }
    }

    this.startIx = 0;
    this.timeOffsets = {};

    /** @type {SynthNote[]} */
    this.entries = [];
    
    /** @type {Array<SynthMixer>}*/
    this.startMixers = [];

    this.invalidatePlan()
  }

  convertTime(synthTime, inputTime, timeZone) {
    if (!this.timeOffsets.hasOwnProperty(timeZone)) {
      this.timeOffsets[timeZone] = synthTime - inputTime; // Exact synd here for accuracy, use synctime to give latency
      // console.trace('Clock sync',timeZone, synthTime, inputTime, inputTime + this.timeOffsets[timeZone]);
    }
    return inputTime + this.timeOffsets[timeZone];
  }

  getTime(timeZone) {
    if (this.timeOffsets.hasOwnProperty(timeZone)) {
      return this.synth.synthTime - this.timeOffsets[timeZone] + this.synth.bufferTime * 2.0;
    } else {
      console.error('No time available for calculating time offset!');
    }
  }

  triggerOnTime(timeZone, time, callback) {
    const result = {timeZone, time, callback};
    const executeTime = this.convertTime(this.synth.synthTime, time, timeZone);
    // console.log('Execute in ',executeTime - this.synth.synthTime, executeTime, this.synth.synthTime);
    this.callbacks.set(result, executeTime);
    return result;
  }
  deleteTrigger(instance) {
    this.callbacks.delete(instance);
  }
  executeTriggers = () => {
    let triggerTime = this.synth.synthTime + this.synth.bufferTime * 2;
    // let entriesToDelete = [];
    for (let [entry,time] of this.callbacks) {
      if (time < triggerTime) {
        // entriesToDelete = entriesToDelete || [];
        // entriesToDelete.push(entry);
        // Apparently this is save so no need for an extra array
        this.callbacks.delete(entry);
        entry.callback();
      }
    }
    // if (entriesToDelete) {
    //   for (let entry of entriesToDelete) {

    //   }
    // }
  }

  syncTime(timeZone, time, thight = false) {
    let synthTime = this.synth.synthTime;
    this.timeOffsets[timeZone] = synthTime - time + (thight ? 0 : this.synth.bufferTime * 2);
  }

  /**
   * 
   * @param {string} timeZone 
   * @param {number} channel 
   * @returns {ControlHandler}
   */
  getChannelControl(timeZone, channel) {
    let key = timeZone + '_' + channel;
    return this.channelControls[key] || 
          (this.channelControls[key] = new ControlHandler(this, timeZone));
  }

  /**
   * Adds a note to be played by the synth
   * @param {number} time Time within this timezon for the note to start 
   * @param {string} timeZone Timezone for this note
   * @param {number} channel Midi channel to play in (usaed for controls)
   * @param {SynthMixer} mixer The mixer to use for playing
   * @param {Partial<NoteData>} noteData Data for the note
   * @returns {SynthNote}
   */
  addNote(time, timeZone, channel, mixer, noteData) {

    // TODO: Remove notedata if possible its vague
    noteData.channel = channel;
    let note = new SynthNote(this, time, timeZone, mixer, noteData, this.getChannelControl(timeZone, channel));

    // console.log('note ', JSON.stringify(noteData,0,2));
    let key = timeZone + '_' + channel;
    // TODO release previous same note on same synth by optional setting
    this.entries.push(note);
    return note;
  }

  /**
   * register a mixer for note entries
   * @param {SynthMixer} startMixer 
   */
  registerStartMixer(startMixer) {
    this.startMixers.push(startMixer);
    this.invalidatePlan();
  }

  unRegisterStartMixer(startMixer) {
    let ix = this.startMixers.indexOf(startMixer);
    if (ix !== -1) {
      this.startMixers.splice(ix,1);
      this.invalidatePlan();
    }
  }

  invalidatePlan() {
    if (!this.invalidateSceduled) {
      this.invalidateSceduled = true;
      defer(() => {
        this.executePlanner.rebuild();
        this.invalidateSceduled = false;
      });
    }
  }

  addControl (time, timeZone, channel, controlType, value) {
    if (time===-1) {
      time = this.getTime(timeZone);
      console.log('calced time: ',time);
    }
    this.getChannelControl(timeZone, channel).addControl(time, controlType, value);
  }

  // TODO create pull construction for playing midi files
  /**
   * Get's all the notes that are playing now
   * @param {number} synthTime 
   * @param {number} bufferTime 
   * @returns {SynthNote[]}
   */
  getCurrentEntries(synthTime, bufferTime) {
    let timedEntries = [];
    for (let ix = this.startIx; ix < this.entries.length; ix++) {
      let entry = this.entries[ix];
      // Only return unfinished notes, they form the root 
      if (entry.isFinished) {
        continue;
      }
      entry.synthStart = this.convertTime(synthTime, entry.startTime, entry.timeZone);
      entry.synthEnd = this.convertTime(synthTime, entry.endTime, entry.timeZone);

      // if (entry.synthStart > (synthTime + bufferTime)) {
      //   let t = entry.synthStart - synthTime;
      //   if (t>0.05) {
      //     this.timeOffsets[entry.timeZone] -= t;
      //   //   // TODO, big difference is clear notes
      //     // console.log('tick correct: ',t);
      //   }
      //   continue;
      // }

      if (!entry.isStarted) {
        // let t = entry.synthStart - synthTime;
        // if (t < 0.0) {
        //   // Prevent multiple times in one run, or does the line here handle that?
        //   this.timeOffsets[entry.timeZone] -= t;
        //   entry.synthStart -= t;
        //   entry.synthEnd -= t;
        //   // console.log('tick correct: ',t);
        // }
        entry.phaseTime = entry.synthStart;
        entry.time = entry.synthStart;
        entry.isStarted = true;
      }

      if (entry.synthEnd > synthTime) {
        timedEntries.push(entry);
      } else {
        if (!entry.isFinished) {
          entry.dispose()
          this.startIx = 0; // if set to ix some notes wont be freed
        }
      }
      // TODO if all is sequential we could mark handled with a new start index
    }
    // Scedule the adding for more notes so it doesn't delay the synth
    this.executeTriggers();
    // setTimeout(this.executeTriggers, 0);
    // this.removeDeadEntries(synthTime);
    return timedEntries;
  }
}


// SynthPlayData.streamProgramNr = streamingTrackData.program;

export default SynthPlayData;