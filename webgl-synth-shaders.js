// Copyright by André van Kammen
// Licensed under CC BY-NC-SA 
// https://creativecommons.org/licenses/by-nc-sa/4.0/

// The shader that calculates the pixel values for the filled triangles
const glsl = x => x[0]; // makes the glsl-literal VS Code extention work
const defaultHeader = `precision highp float;
precision highp int;
precision highp sampler2DArray;

in vec2 pixel_position;

in float phase;
in float time;
in float releaseTime;

in float note;
in float velocity;
in float releaseVelocity;
in float aftertouch;

flat in ivec3 trackLineInfo;

layout(location = 0) out vec4 fragColor;

uniform float startTime;

uniform sampler2D controlTexture;
uniform sampler2D inputTexture;
uniform int inputTextureHeight;

uniform sampler2DArray sampleTextures;

// Some missing constants
const float pi = 3.141592653589793;
const float pi2 = 6.283185307179586;

float getControl(int x) {
  vec4 controlData = texelFetch(controlTexture, ivec2(x,0), 0);
  return mix(controlData.x, controlData.z, round(pixel_position.x) / float(bufferWidth));
}

const float sampleTime = (1.0 / float(sampleRate));
const float bufferTime = (sampleTime * float(bufferWidth));

#define sampleFrequency (8.175798915643707 * pow(2.0, note / 12.0))
#define samplePhase (phase * sampleFrequency * pi2)

#define synthTime (startTime + (round(pixel_position.x) * sampleTime))

// Some default midi controls
#define modulation getControl(1)
#define expression getControl(11)
#define volume getControl(7)
#define pan getControl(10)
#define program getControl(128)
#define pitch getControl(129)
#define pitchRange getControl(131)
#define pressure getControl(130)

float noise(float phase) {
  return fract(sin(dot(phase,
                       123.9898))*
            93758.5453123);
}

vec4 getSingleInputSample4(int sampleNr) {
  float sampleX = float(sampleNr) / float(bufferWidth);

  int inputLine = int(floor(float(trackLineInfo.z) + sampleX));
  if (inputLine < trackLineInfo.x) {
    int diff = inputLine - trackLineInfo.x;
    inputLine = trackLineInfo.x + trackLineInfo.y + diff;
  }

  // Interpolation can not work here because of buffer borders, this gives clicking sounds
  // So we interpolate outside this function

  return
    texelFetch(sampleTextures,
               ivec3(int(floor(fract(sampleX) * float(bufferWidth))),
                     inputLine % bufferHeight, 
                     inputLine / bufferHeight),0);
}

vec4 getSingleInputSample4(float deltaTime) {
  float sampleX = round(pixel_position.x) / float(bufferWidth);
  float bufferDeltaX = deltaTime / bufferTime;
  sampleX += bufferDeltaX;

  int inputLine = int(floor(float(trackLineInfo.z) + sampleX));
  if (inputLine < trackLineInfo.x) {
    int diff = inputLine - trackLineInfo.x;
    inputLine = trackLineInfo.x + trackLineInfo.y + diff;
  }

  // Interpolation can not work here because of buffer borders, this gives clicking sounds
  // So we interpolate outside this function

  return
    texelFetch(sampleTextures,
               ivec3(int(floor(fract(sampleX) * float(bufferWidth))),
                     inputLine % bufferHeight, 
                     inputLine / bufferHeight),0);
}

vec2 getSingleInputSample(float deltaTime) {
  return getSingleInputSample4(deltaTime).xy;
}

vec2 getInputSample(float deltaTime) {
  if (deltaTime > 0.0 || deltaTime < float(trackLineInfo.y) * -bufferTime) {
    return vec2(0.0);
  }

  float sampleCount = -deltaTime / sampleTime;
  float sampleCountFloor = floor(sampleCount);

  // startPoint and endPoint when thinking backwards in history
  vec2 startPoint = getSingleInputSample((-sampleCountFloor-0.5) * sampleTime);
  vec2 endPoint = getSingleInputSample((-sampleCountFloor-1.5) * sampleTime);

  // Return interpolation between the two values
  float n = fract(sampleCount);
  return startPoint * n + endPoint * (1.0 - n);
}

`;

const SystemShaders = {
vertex: glsl`precision highp float;
precision highp int;
precision highp sampler2DArray;

in vec4 vertexPosition;
in vec4 attributes2;
in vec4 attributes3;

// Some of these could be done by uniform in vertex, but that would require seperate draw calls
out vec2 pixel_position;
out float phase;
out float time;
out float releaseTime;

out float note; // Note number in MIDI 0-127
out float velocity; // Velocity 0.0 - 1.0
out float releaseVelocity;
out float aftertouch; // Aftertouch 0.0 - 1.0
flat out ivec3 trackLineInfo; // Input line info from sampleBuffer
flat out int backBufferIx;

const float offsetCorrection = 0.5 / float(bufferWidth) * float(bufferWidth-1);

void main(void) {
  pixel_position.x = bool(gl_VertexID % 2) //vertexPosition.x > 0.0)
                   ? float(bufferWidth) - offsetCorrection
                   : -offsetCorrection;

  time            = vertexPosition.x;
  phase           = vertexPosition.z;
  releaseTime     = vertexPosition.w; 

  note            = attributes2.x;
  velocity        = attributes2.y;
  releaseVelocity = attributes2.z;
  aftertouch      = attributes2.w;

  trackLineInfo = ivec3(floor(attributes3.xyz));

  backBufferIx = int(floor(attributes3.w));

  gl_Position = vec4(-1.0+2.0*float(gl_VertexID % 2), vertexPosition.y, 0.0, 1.0);
}`,
"zero": glsl`precision highp float;
layout(location = 0) out vec4 fragColor;
void main(void) {
  fragColor = vec4(0.0, 0.0, 0.0, 0.0);
}`,
"mixdown": `precision highp float;
precision highp int;
precision highp sampler2DArray;

in vec2 pixel_position;

flat in ivec3 trackLineInfo;
uniform sampler2DArray sampleTextures;

layout(location = 0) out vec4 fragColor;

void main(void) {
  vec4 sampleValue = 
                    texelFetch(sampleTextures,
                               ivec3(round(pixel_position.x),
                                     trackLineInfo.z % bufferHeight, 
                                     trackLineInfo.z / bufferHeight),0);
  fragColor = sampleValue;
}
`,
effect: defaultHeader + glsl`

{EffectFunction}

void main(void) {
  fragColor = vec4(vec2(effectMain()), 0.0, 1.0);
}
`,
effect4: defaultHeader + glsl`

{EffectFunction}

void main(void) {
  fragColor = effectMain();
}
`,
"waveform": defaultHeader + glsl`
// Default attack decay time, can be overwritten in the user functions
float attackTime = 0.005;
float decayTime = 0.2;

vec2 sampleToStereo(vec2 sampleValue) {
  return vec2(
    sampleValue.x * (1.0 - pan),
    sampleValue.y * pan);
}

vec2 applyLevels(vec2 sampleValue, float attackTime, float decayTime) {
  // Set an attack ramp of <attackTime>
  sampleValue *= smoothstep(0.0, attackTime, time);

  // Handle the velocity of the key
  sampleValue *= velocity;

  // Handle the volume of the channel
  sampleValue *= volume * expression;

  // Dampen the sound in <decayTime> after release
  sampleValue *= 1.0 - smoothstep(releaseTime, 
                                  releaseTime + decayTime,
                                  time);
  return sampleValue;
}

vec2 applyLevels(vec2 sampleValue) {
  // Use default attack of 5ms and decay of 200ms
  return applyLevels(sampleValue, attackTime, decayTime);
}

// Some basic wave shapes
float saw     (float phase) { return 1.0 - 2.0 * mod(phase, pi2) / pi2; }
float triangle(float phase) { return 1.0 - 2.0 * abs(saw(phase)); }
float block   (float phase) { return sign(saw(phase)); }

{WaveformFunction}

void main(void) {
  if (time<0.0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Call the user function, and convert to stereo if necessary
  vec2 sampleValue = vec2(waveform(sampleFrequency, samplePhase));

  // Apply all the volumes for attack, release, volume and velocity
  sampleValue = applyLevels(sampleValue);

  // Return the sound to the videocard buffer
  fragColor = vec4(sampleToStereo(sampleValue), 0.0, 1.0);
}`,

playInput: glsl`// #synth-note-mode: exclusive // don't start the same not twice
// options could be: all/exclusive/poly/mono/glide

precision highp float;
precision highp sampler2D;

flat in int backBufferIx;

in float phase; // PHASE ACCURATE ENOUGH?
in float time; // TIME ACCURATE ENOUGH?
in float releaseTime;

in float note;
in float velocity;
in float aftertouch;

#define modulation getControl(1)
#define pan getControl(10)
#define pitch getControl(257)
#define volume getControl(7)

out vec4 fragColor;

uniform sampler2D controlTexture;

const float pi2 = 6.283185307179586;

float getControl(int x) {
  // TODO interpolation
  return texelFetch(controlTexture, ivec2(x,0), 0).x;
}

in vec2 pixel_position;

uniform sampler2D inputTexture;
uniform int inputTextureHeight;

const int streamBlocks = 4; // TODO get for streambuffer

const int channelCount = 2; // TODO get for track
const int streamSampleRate = sampleRate; // TODO get for track

const int samplesPerVec4 = 4 / channelCount;
const int streamVec4Count = (streamBlocks * bufferWidth);
const int streamSampleCount = streamVec4Count * samplesPerVec4;

void main(void) {

  // int trackOffset = int(note) * trackSize;
  // int sampleNr = int(floor(time * float(sampleRate))) % trackSize;
  // int fragNr = (trackOffset + sampleNr) / channelCount;
  int sampleNr = int(round(phase * float(streamSampleRate)));
  if (sampleNr <0) {
    fragColor = vec4(0.0);
    return;
  }

  int fragNr = 
    int(floor(note)) * streamVec4Count + // buffer start
    (sampleNr / samplesPerVec4) % streamVec4Count;

  vec4 fragVal = texelFetch( inputTexture, 
                             ivec2( fragNr % bufferWidth,
                                    fragNr / bufferWidth),0);

  vec2 sampleVal = sampleNr % 2 == 0 ? fragVal.xy : fragVal.zw;

  // sampleVal = vec2(sin(time*440.0*pi2));
  // if (time>=releaseTime) {
  //   sampleVal = vec2(0.0);
  // }
  sampleVal *= 
    aftertouch *
    volume *
    clamp(time * 50.,0.0,1.0) * // 20ms attack
    (1.0 - clamp((time - releaseTime) * 40., 0.0, 1.0)); // 20ms decay

  // sampleVal *= vec2(pan, 1.0 - pan);
  // sampleVal += sin(float(sampleNr)/100.0*pi2);
  
  // Return the sound to the videocard buffer at half volume
  fragColor = vec4(clamp(sampleVal,-1.0,1.0), 0.0, 1.0);
}
`,

copyLineVertex: glsl`precision highp float;
precision highp int;
precision highp sampler2DArray;
in vec4 vertexPosition;

out float lineX;
flat out ivec3 trackLineInfo;

const float offsetCorrection = 0.5 / float(bufferWidth) * float(bufferWidth-1);
void main(void) {
  lineX = floor((vertexPosition.x + 1.0) * 0.5 * (float(bufferWidth) - 0.5));
  
  if (vertexPosition.x > 0.1) {
    lineX = float(bufferWidth) - offsetCorrection;
  } else {
    lineX = -offsetCorrection;
  }
  trackLineInfo.x = int(floor(vertexPosition.y));
  trackLineInfo.y = int(floor(vertexPosition.z));
  trackLineInfo.z = int(floor(vertexPosition.w));
  
  gl_Position = vec4(vertexPosition.x, 0.5, 1.0, 1.0);
}`,
copyLine: glsl`precision highp float;
precision highp int;
precision highp sampler2DArray;

in float lineX;
flat in ivec3 trackLineInfo;

layout(location = 0) out vec4 fragColor;

uniform sampler2DArray sampleTextures0;
uniform sampler2DArray sampleTextures1;

void main(void) {
  int currentBuffer = trackLineInfo.x;
  int currentLine = trackLineInfo.y;
  vec4 sampleValue;
  if (trackLineInfo.z == 0) {
    sampleValue = texelFetch(sampleTextures0,
        ivec3(round(lineX), 
              currentLine,
              currentBuffer), 0);
  } else {
    sampleValue = texelFetch(sampleTextures1,
        ivec3(round(lineX), 
              currentLine,
              currentBuffer), 0);
  }
  fragColor = sampleValue;
}`,

rmsAvgEngMaxVertex: glsl`precision highp float;
precision highp int;
precision highp sampler2DArray;

uniform sampler2D tliDataTexture;

flat out int currentBuffer;
flat out int currentLine;
flat out int texNr;
flat out int lineX;
flat out int stepSize;

void main(void) {
  int vertexIx = gl_VertexID; 
  int tliIx = vertexIx / bufferWidth;
  lineX = (vertexIx % bufferWidth);

  vec4 tliData = texelFetch(tliDataTexture, ivec2(tliIx % bufferWidth, tliIx / bufferWidth), 0);
  texNr = int(tliData.x) % 2;
  
  int lineIx = int(tliData.y);
  currentLine = lineIx % bufferHeight;
  currentBuffer = lineIx / bufferHeight;
  
  int divider = int(tliData.w);
  stepSize = (bufferWidth / divider);

  int bufferIx = int(tliData.z) + lineX / stepSize;
  // int bufferIx = lineIx + texNr * bufferHeight * bufferCount;

  // Calculate position in volume buffer
  float outputX = -1.0 + 2.0 * (float(bufferIx % bufferWidth) + 0.5) / float(bufferWidth);
  float outputY = -1.0 + 2.0 * (float(bufferIx / bufferWidth) + 0.5) / float(bufferHeight);
  
  gl_PointSize = 1.0;
  gl_Position = vec4(outputX, outputY, 1.0, 1.0);
}`,

rmsAvgEngMax: glsl`precision highp float;
precision highp int;
precision highp sampler2DArray;

uniform sampler2DArray sampleTextures0;
uniform sampler2DArray sampleTextures1;

flat in int currentBuffer;
flat in int currentLine;
flat in int texNr;
flat in int lineX;
flat in int stepSize;

layout(location = 0) out vec4 outColor0;
layout(location = 1) out vec4 outColor1;

void main(void) {
  vec2 sampleValue;
  vec2 sampleValuePrev;
  if (texNr == 0) {
    sampleValuePrev = texelFetch(sampleTextures0,
      ivec3( max(lineX-1,0), 
             currentLine,
             currentBuffer), 0).rg;
    sampleValue = texelFetch(sampleTextures0,
      ivec3( lineX, 
             currentLine,
             currentBuffer), 0).rg;
  } else {
    sampleValuePrev = texelFetch(sampleTextures1,
      ivec3( max(lineX-1,0), 
             currentLine,
             currentBuffer), 0).rg;
    sampleValue = texelFetch(sampleTextures1,
      ivec3( lineX, 
             currentLine,
             currentBuffer), 0).rg;
  }

  vec2 deltaValue = abs(sampleValuePrev - sampleValue);
  // deltaValue *= deltaValue;
  deltaValue /= float(stepSize);
  vec2 avgValue = sampleValue / float(stepSize);
  vec2 rmsValue = sampleValue * avgValue;
  outColor0 = vec4(rmsValue.x, avgValue.x, deltaValue.x, abs(sampleValue.x));
  outColor1 = vec4(rmsValue.y, avgValue.y, deltaValue.y, abs(sampleValue.y));
}`
}
export default SystemShaders
