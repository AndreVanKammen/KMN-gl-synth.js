class ControlRecord {
  name = '';          // The name of the variable for use in the shaderCode, will be the name of a define which does the call or a const set
  controlNr = -1;             // The midi-controlnr to get the value from -1 if there is none
  converterName = '';       // The name of a GLSL converter function, this could also be an envelope generator
  /** @type {number[]} */
  converterParams = []; // array of float eg. -70, 6 for dBtoLinear

  /**
   * 
   * @param {string} name 
   * @param {number} controlNr 
   * @param {string} converterName 
   * @param {number[]} converterParams 
   */
  constructor(name, controlNr, converterName, converterParams) {
    this.name = name;
    this.controlNr = controlNr;
    this.converterName = converterName;
    this.converterParams = converterParams;
  }
}
class ConverterRecord {
  name = '';
  code = '';
}

export class WebGLSynthControls {
  constructor() {
    /** @type {Record<string,ConverterRecord>} */
    this.converters = {};
    /** @type {Record<string,ControlRecord>} */
    this.controls = {};
  }

  setControl(name, controlNr, converterName, converterParams) {
    this.controls[name] = new ControlRecord(name, controlNr, converterName, converterParams);
  }

  createDefaultMidiControls() {
    this.setControl('modulation', 1);
    this.setControl('expression', 11);
    this.setControl('volume', 7);
    this.setControl('pan', 10);
    this.setControl('program', 128);
    this.setControl('pitch', 129);
    this.setControl('pitchRange', 131);
    this.setControl('pressure', 130);
  }

  getControlsShaderCode(shaderCode) {
    let resultStr = '';
    for (let name of Object.keys(this.controls)) {
      resultStr += `#define ${name} getControl(${this.controls[name].controlNr})\n`;
    }
    console.log('getControlsShaderCode:', resultStr);
    return resultStr;
  }
    
}