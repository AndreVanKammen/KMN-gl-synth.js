// This file is for handling all the controls, presets and samples which function
// as input for the synth.

// TODO rename timeZone to midiInputName

export class SynthInput {
  constructor (synth) {
    this.synth = synth;
    this.controlLineWidth = 1024;

    // Get our buffer with 4 elements per channel as this seems to be the default for modern video-cards
    // Getting 2 elements wil only cause overhead in memory usage, i found no difference in memory usage
    // with angle on OPENGL in chrome or default 2 or 4 elements always same memory usage on GTX 1070
    // we could double the line count and make odd lines use the last 2 elements
  }
  
  /**
   * Get a free line in the texture buffer for the controls of a channel
   * @param {string} timeZone name of the synth driving this
   * @param {number} channelNr channel number (with 16 * trackNr added for midifiles)
   * @returns {number} The index (y position) in the control list
   */
  getControlsForChannel(timeZone, channelNr) {
    let key = 'ch_' + timeZone + '_' + channelNr;
    return this.getdataForKey(key,1);
  }
  
  /**
   * Get a free line in the texture buffer for the presets of a shader
   * @param {string} instrumentName Name of the instrument
   * @param {number} passNrOffset The offset of the shader within the instrument (0=input,1..x=preeffects,x..y=posteffects)
   * @returns {number} The index (y position) in the control list
   */
   getPresetForShader(instrumentName, passNrOffset) {
    let key = 'sdr_' + instrumentName + '_' + passNrOffset;
    return this.getdataForKey(key,1);
  }

  getdataForKey(keyName, lineCount) {
    let result = 0;
    return result;
  }

}