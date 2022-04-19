import AudioInput from "./audio-input.js";
import { SampleBank, SampleData } from "./sample-bank.js";
import { SynthMixer, SynthNote } from "./webgl-synth-data.js";

export class SampleRecorder extends SampleBank {
  /**
   * 
   * @param {SynthMixer} mixer 
   * @param {number} capacity 
   */
  constructor(mixer, capacity) {
    super(capacity);
    this.mixer = mixer;
    this.audioInput = new AudioInput(); 
    this.audioInput.onAudioBuffer = this.handleRecordAudio.bind(this);
    this.recordOffset = 0;
    /** @type {SampleData} */
    this.recordTrack = null;
    this.recordTrackNr = -1;
    this.recordTimeout = 4;
    this.audioInput.startCapture();
  }

  startRecording(trackNr) {
    this.recordTrack = new SampleData(this.sampleBuffer, this.recordOffset, 0);
    this.recordTrackNr = trackNr;
    console.log('Start recording ', this.recordTrackNr, this.recordOffset);
  }

  endRecording() {
    console.log('end recording', this.recordTrackNr, this.recordTrack.sampleLength);
    this.tracks[this.recordTrackNr] = this.recordTrack;
    this.recordTrackNr = -1;
    this.recordTrack = null;
  }

  handleRecordAudio(leftSamples, rightSamples) {
    if (this.recordTrack) {
      for (let ix = 0; ix < leftSamples.length; ix++) {
        this.sampleBuffer.leftSamples[this.recordOffset + ix] = leftSamples[ix];
        this.sampleBuffer.rightSamples[this.recordOffset + ix] = rightSamples[ix];
      }
      this.recordOffset += leftSamples.length;
      this.recordTrack.sampleLength += leftSamples.length;
      if (this.recordTimeout-- <= 0) {
        this.endRecording();
      }
    }
  }

  /**
   * @param {SynthNote} noteEntry
   */
  getData(noteEntry) {
    if (!this.tracks[noteEntry.note] || this.recordTrack) {
      if (!this.recordTrack) {
        this.startRecording(noteEntry.note);
      }
      // if (this.recordTrackNr !== trackNr) {
      //   this.endRecording();
      //   this.startRecording(trackNr);
      // }
      
      this.recordTimeout = 4; // TODO calculate based on buffersizes
    } else {
      if (this.recordTrack) {
        this.endRecording();
      } else {
        let track = this.tracks[noteEntry.note];
        console.log('Play Track:', track.sampleOffset, track.sampleLength);
      }
    }
    return super.getData(noteEntry);
  }

}