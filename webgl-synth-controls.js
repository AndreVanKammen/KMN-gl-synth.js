class ControlRecord {
  /**
   * 
   * @param {string} name The name of the variable for use in the shaderCode, will be the name of a define which does the call or a const set
   * @param {string} converterName The name of a GLSL converter function, this could also be an envelope generator
   * @param {number[]} converterParams array of float eg. -70, 6 for dBtoLinear 
   */
  constructor(name, converterName, converterParams) {
    this.name = name;
    this.converterName = converterName;
    this.converterParams = converterParams;
  }
}
class ConverterRecord {
  /**
   * 
   * @param {string} name 
   * @param {string} code 
   */
  constructor(name, code) {
    this.name = name;
    this.code = code;
  }
}

export class WebGLSynthControls {
  constructor() {
    /** @type {Record<string,ConverterRecord>} */
    this.converters = {};
    /** @type {Record<string,ControlRecord>} */
    this.controls = {};
  }

  /**
   * 
   * @param {string} name functions name
   * @param {string} code GLSL function code for converting params to a value can use getControl
   */
  setConverter(name, code) {
    this.converters[name] = new ConverterRecord(name, code);
  }

  /**
   * 
   * @param {string} name The name of the variable for use in the shaderCode, will be the name of a define which does the call or a const set
   * @param {string} converterName The name of a GLSL converter function, this could also be an envelope generator
   * @param {number[]} converterParams array of float eg. -70, 6 for dBtoLinear 
   */
  setControl(name, converterName, converterParams) {
    this.controls[name] = new ControlRecord(name, converterName, converterParams);
  }

  createDefaultMidiControls() {
    this.setControl('modulation', 'getControl',[1]);
    this.setControl('expression', 'getControl',[11]);
    this.setControl('volume', 'getControl',[7]);
    this.setControl('pan', 'getControl',[10]);
    this.setControl('program', 'getControl',[128]);
    this.setControl('pitch', 'getControl',[129]);
    this.setControl('pitchRange', 'getControl',[131]);
    this.setControl('pressure', 'getControl',[130]);
  }

  getControlsShaderCode(shaderCode) {
    let resultStr = '\n';
    for (let name of Object.keys(this.converters)) {
      resultStr += this.converters[name].code + '\n';
    }
    resultStr += '\n';
    for (let name of Object.keys(this.controls)) {
      let cr = this.controls[name];
      resultStr += `#define ${name} ${cr.converterName}(${cr.converterParams.join(',')})\n`;
    }
    console.log('getControlsShaderCode:', resultStr);
    return resultStr;
  }
    
}