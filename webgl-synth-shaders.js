// Copyright by André van Kammen
// Licensed under CC BY-NC-SA
// https://creativecommons.org/licenses/by-nc-sa/4.0/

// const needs_flat = 'flat '; // ints and ivec needs to be flat, but flat causes performance issues for WebGL over metal
// const ivec3 = 'ivec3';
// const int = 'int';

const needs_flat = ''; // ints and ivec needs to be flat, but flat causes performance issues for WebGL over metal
const ivec3 = 'vec3';
const int = 'float';

// The shader that calculates the pixel values for the filled triangles
const defaultHeader = /*glsl*/`
precision highp int;
precision highp float;
precision highp sampler2DArray;

in vec2 pixel_position;

in float phaseTime;
in float time;
in float releaseTime;

in float note;
in float velocity;
in float releaseVelocity;
in float aftertouch;

${needs_flat}in ${ivec3} trackLineInfo;

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

float getControlNoInterpolation(int x) {
  vec4 controlData = texelFetch(controlTexture, ivec2(x,0), 0);
  return controlData.x;
}

const float sampleTime = (1.0 / float(sampleRate));
const float bufferTime = (sampleTime * float(bufferWidth));

#define sampleFrequency (8.175798915643707 * pow(2.0, note / 12.0))
#define samplePhase (phaseTime * sampleFrequency * pi2)

#define synthTime (startTime + (round(pixel_position.x) * sampleTime))

// Some default midi controls
// #include controls

float noise(float phase) {
  return fract(sin(dot(phase,
                       123.9898))*
            93758.5453123);
}

vec4 getSingleInputSample4(int sampleNr) {
  float sampleX = float(sampleNr) / float(bufferWidth);

  int inputLine = int(floor(float(trackLineInfo.z) + sampleX));
  if (inputLine < int(trackLineInfo.x)) {
    int diff = inputLine - int(trackLineInfo.x);
    inputLine = int(trackLineInfo.x) + int(trackLineInfo.y) + diff;
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
  if (inputLine < int(trackLineInfo.x)) {
    int diff = inputLine - int(trackLineInfo.x);
    inputLine = int(trackLineInfo.x) + int(trackLineInfo.y) + diff;
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

vec2 getInputSample(float deltaTime, float spreadTime) {
  if (deltaTime > 0.0 || deltaTime < float(trackLineInfo.y) * -bufferTime) {
    return vec2(0.0);
  }

  float sampleCount = -deltaTime / sampleTime;
  float sampleCountFloor = floor(sampleCount);
  float spreadSamples = max(ceil(spreadTime / sampleTime),1.0) * 0.5;

  // startPoint and endPoint when thinking backwards in history
  float startPoint = (-sampleCountFloor - spreadSamples) * sampleTime;
  float endPoint = (-sampleCountFloor + spreadSamples) * sampleTime;
  float pointWidth = endPoint - startPoint;

  vec2 result = vec2(0.0);
  float weight = 0.0;
  for (float st = startPoint; st <= endPoint; st += sampleTime) {
    float w = 0.5 - 0.5 * cos((st - startPoint) / pointWidth * pi2);
    result += getSingleInputSample(st) * w;
    weight += w;
  }

  return result / weight;
}

`;

const SystemShaders = {
vertex: /*glsl*/`precision highp float;
precision highp int;
precision highp sampler2DArray;

in vec4 vertexPosition;
in vec4 attributes2;
in vec4 attributes3;

// Some of these could be done by uniform in vertex, but that would require seperate draw calls
out vec2 pixel_position;
out float phaseTime;
out float time;
out float releaseTime;

out float note; // Note number in MIDI 0-127
out float velocity; // Velocity 0.0 - 1.0
out float releaseVelocity;
out float aftertouch; // Aftertouch 0.0 - 1.0
${needs_flat}out ${ivec3} trackLineInfo; // Input line info from sampleBuffer
${needs_flat}out ${int} backBufferIx;

const float offsetCorrection = 0.5 / float(bufferWidth) * float(bufferWidth-1);

void main(void) {
  pixel_position.x = bool(gl_VertexID % 2) //vertexPosition.x > 0.0)
                   ? float(bufferWidth) - offsetCorrection
                   : -offsetCorrection;

  time            = vertexPosition.x;
  phaseTime       = vertexPosition.z;
  releaseTime     = vertexPosition.w;

  note            = attributes2.x;
  velocity        = attributes2.y;
  releaseVelocity = attributes2.z;
  aftertouch      = attributes2.w;

  trackLineInfo = ${ivec3}(floor(attributes3.xyz));

  backBufferIx = ${int}(floor(attributes3.w));

  gl_Position = vec4(-1.0+2.0*float(gl_VertexID % 2), vertexPosition.y, 0.0, 1.0);
}`,
vertexPull: /*glsl*/`precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D vertexPullTexture;

// Some of these could be done by uniform in vertex, but that would require seperate draw calls
out vec2 pixel_position;
out float phaseTime;
out float time;
out float releaseTime;

out float note; // Note number in MIDI 0-127
out float velocity; // Velocity 0.0 - 1.0
out float releaseVelocity;
out float aftertouch; // Aftertouch 0.0 - 1.0
${needs_flat}out ${ivec3} trackLineInfo; // Input line info from sampleBuffer
${needs_flat}out ${int} backBufferIx;

const float offsetCorrection = 0.5 / float(bufferWidth) * float(bufferWidth-1);

void main(void) {
  int vertexIx = (gl_VertexID / 2) * 4;

  int vert1 = vertexIx + gl_VertexID % 2;
  vec4 vertexPosition = texelFetch(vertexPullTexture, ivec2(vert1 % 1024, vert1 / 1024), 0);
  vertexIx += 2;
  vec4 attributes2 = texelFetch(vertexPullTexture, ivec2(vertexIx % 1024, vertexIx / 1024), 0);
  vertexIx++;
  vec4 attributes3 = texelFetch(vertexPullTexture, ivec2(vertexIx % 1024, vertexIx / 1024), 0);

  pixel_position.x = bool(gl_VertexID % 2) //vertexPosition.x > 0.0)
                   ? float(bufferWidth) - offsetCorrection
                   : -offsetCorrection;

  time            = vertexPosition.x;
  phaseTime       = vertexPosition.z;
  releaseTime     = vertexPosition.w;

  note            = attributes2.x;
  velocity        = attributes2.y;
  releaseVelocity = attributes2.z;
  aftertouch      = attributes2.w;

  trackLineInfo = ${ivec3}(floor(attributes3.xyz));

  backBufferIx = ${int}(floor(attributes3.w));

  gl_Position = vec4(-1.0+2.0*float(gl_VertexID % 2), vertexPosition.y, 0.0, 1.0);
}`,
"zero": /*glsl*/`precision highp float;
layout(location = 0) out vec4 fragColor;
void main(void) {
  fragColor = vec4(0.0, 0.0, 0.0, 0.0);
}`,
"mixdown": /*glsl*/`precision highp float;
precision highp int;
precision highp sampler2DArray;

in vec2 pixel_position;

${needs_flat}in ${ivec3} trackLineInfo;
uniform sampler2DArray sampleTextures;

layout(location = 0) out vec4 fragColor;

void main(void) {
  vec4 sampleValue =
                    texelFetch(sampleTextures,
                               ivec3(round(pixel_position.x),
                                     int(trackLineInfo.z) % bufferHeight,
                                     int(trackLineInfo.z) / bufferHeight),0);
  fragColor = sampleValue;
}
`,
effect: defaultHeader + /*glsl*/`

{EffectFunction}

void main(void) {
  fragColor = vec4(vec2(effectMain()), 0.0, 1.0);
}
`,
effect4: defaultHeader + /*glsl*/`

{EffectFunction}

void main(void) {
  fragColor = effectMain();
}
`,
  "waveform": defaultHeader + /*glsl*/`
struct Envelope {
  float attack;
  float decay;
  float sustain;
  float release;
};

// Default attack decay time, can be overwritten in the user functions
Envelope envelope = Envelope(0.005, 0.0, 1.0, 0.2);

vec2 sampleToStereo(vec2 sampleValue) {
  return vec2(
    sampleValue.x * (1.0 - pan),
    sampleValue.y * pan);
}

float getEnvelopeValue(Envelope env) {
  float value = 1.0;
  value *= smoothstep(0.0, env.attack, time);
  value *= 1.0 - smoothstep(releaseTime,
    releaseTime + env.release,
    time);
  return value;
  // env *= clamp(time, 0.0, attack);
  // env *= clamp(time - releaseTime, 0.0, release);
}

vec2 applyLevels(vec2 sampleValue) {
    // Handle the velocity of the key
  sampleValue *= velocity;

  // Handle the volume of the channel
  sampleValue *= volume * expression;

  // Handle the envelope
  sampleValue *= getEnvelopeValue(envelope);

  return sampleValue;
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

playInput: /*glsl*/`// #synth-note-mode: exclusive // don't start the same not twice
// options could be: all/exclusive/poly/mono/glide

precision highp int;
precision highp float;
precision highp sampler2D;

${needs_flat}in ${int} backBufferIx;

in float phaseTime; // PHASE ACCURATE ENOUGH?
in float time; // TIME ACCURATE ENOUGH?
in float releaseTime;

in float note;
in float velocity;

out vec4 fragColor;

uniform sampler2D controlTexture;

const float pi2 = 6.283185307179586;

#define envReleaseTime getControl(72)
#define envAttackTime getControl(73)

in vec2 pixel_position;

uniform sampler2D inputTexture;
uniform int inputTextureHeight;

uniform int streamBlocks;

const int channelCount = 2; // TODO get for track
const int streamSampleRate = sampleRate; // TODO get for track

const int samplesPerVec4 = 4 / channelCount;

float getControl(int x) {
  vec4 controlData = texelFetch(controlTexture, ivec2(x,0), 0);
  float val = mix(controlData.x, controlData.z, round(pixel_position.x) / float(bufferWidth));
  return val;
}

// #include controls

vec2 getSample(int sampleNr, int streamVec4Count, int bufStart) {
  int fragNr = bufStart + (sampleNr / samplesPerVec4) % streamVec4Count;

  vec4 fragVal = texelFetch( inputTexture,
                              ivec2( fragNr % bufferWidth,
                                     fragNr / bufferWidth),0);

  return sampleNr % 2 == 0 ? fragVal.xy : fragVal.zw;
}

void main(void) {
  int streamVec4Count = (streamBlocks * bufferWidth);
  // int streamSampleCount = streamVec4Count * samplesPerVec4;

  // int trackOffset = int(note) * trackSize;
  // int sampleNr = int(floor(time * float(sampleRate))) % trackSize;
  // int fragNr = (trackOffset + sampleNr) / channelCount;
  float sampleNrFloat = phaseTime * float(streamSampleRate);
  int sampleNr = int(floor(sampleNrFloat));
  if (sampleNr <0) {
    fragColor = vec4(0.0);
    return;
  }

  int bufStart = int(floor(note)) * streamVec4Count;

  sampleNrFloat = mod(sampleNrFloat, 1.0);
  // TODO find out why +2 matches better
  vec2 sampleVal = getSample(sampleNr + 2, streamVec4Count, bufStart);
        //  getSample(sampleNr, streamVec4Count, bufStart) * (1.0 - sampleNrFloat) +
        //  getSample(sampleNr + 1, streamVec4Count, bufStart) * sampleNrFloat;

  // sampleVal = vec2(sin(time*44.0*pi2));
  // if (time>=releaseTime) {
  //   sampleVal = vec2(0.0);
  // }
  sampleVal *=
    volume *
    clamp(time * (1000.0/envAttackTime),0.0,1.0) * // 10ms attack
    (1.0 - clamp((time - releaseTime) * (1000.0/envReleaseTime), 0.0, 1.0)); // 10ms decay

  float p = pan * 2.0;
  sampleVal *= vec2((2.0 - p), p);

  // if ((time<0.0) || (time>releaseTime)) {
  //   sampleVal *= 0.0;
  // }
    // sampleVal *= vec2(pan, 1.0 - pan);
  // sampleVal += sin(float(sampleNr)/100.0*pi2);

  // Return the sound to the videocard buffer at half volume
  fragColor = vec4(sampleVal, 0.0, 1.0);
}
`,

copyLineVertex: /*glsl*/`precision highp float;
precision highp int;
precision highp sampler2DArray;
in vec4 vertexPosition;

out float lineX;
${needs_flat}out ${ivec3} trackLineInfo;

const float offsetCorrection = 0.5 / float(bufferWidth) * float(bufferWidth-1);
void main(void) {
  lineX = floor((vertexPosition.x + 1.0) * 0.5 * (float(bufferWidth) - 0.5));

  if (vertexPosition.x > 0.1) {
    lineX = float(bufferWidth) - offsetCorrection;
  } else {
    lineX = -offsetCorrection;
  }
  int currentLine = int(floor(vertexPosition.z));
  trackLineInfo.xyz = ${ivec3}(currentLine / bufferHeight,
                               currentLine % bufferHeight,
                               floor(vertexPosition.w));

  gl_Position = vec4(vertexPosition.x, vertexPosition.y, 0.0, 1.0);
}`,
copyLine: /*glsl*/`precision highp float;
precision highp int;
precision highp sampler2DArray;

in float lineX;
${needs_flat}in ${ivec3} trackLineInfo;

layout(location = 0) out vec4 fragColor;

uniform sampler2DArray sampleTextures0;
uniform sampler2DArray sampleTextures1;

void main(void) {
  int currentBuffer = int(trackLineInfo.x);
  int currentLine = int(trackLineInfo.y);
  vec4 sampleValue;
  if (int(trackLineInfo.z) == 0) {
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

rmsAvgEngMaxVertex: /*glsl*/`precision highp float;
precision highp int;
precision highp sampler2DArray;

uniform sampler2D tliDataTexture;

${needs_flat}out ${int} currentBuffer;
${needs_flat}out ${int} currentLine;
${needs_flat}out ${int} texNr;
${needs_flat}out ${int} lineX;
${needs_flat}out ${int} stepSize;

void main(void) {
  int vertexIx = gl_VertexID;
  int tliIx = vertexIx / bufferWidth;
  lineX = ${int}(vertexIx % bufferWidth);

  vec4 tliData = texelFetch(tliDataTexture, ivec2(tliIx % bufferWidth, tliIx / bufferWidth), 0);
  texNr = ${int}(int(tliData.x) % 2);

  int lineIx = int(tliData.y);
  currentLine = ${int}(lineIx % bufferHeight);
  currentBuffer = ${int}(lineIx / bufferHeight);

  int divider = int(tliData.w);
  stepSize = ${int}(bufferWidth / divider);

  int bufferIx = int(tliData.z) + int(lineX) / int(stepSize);
  // int bufferIx = lineIx + texNr * bufferHeight * bufferCount;

  // Calculate position in volume buffer
  float outputX = -1.0 + 2.0 * (float(bufferIx % bufferWidth) + 0.5) / float(bufferWidth);
  float outputY = -1.0 + 2.0 * (float(bufferIx / bufferWidth) + 0.5) / float(bufferHeight);

  gl_PointSize = 1.0;
  gl_Position = vec4(outputX, outputY, 1.0, 1.0);
}`,

rmsAvgEngMax: /*glsl*/`precision highp float;
precision highp int;
precision highp sampler2DArray;

uniform sampler2DArray sampleTextures0;
uniform sampler2DArray sampleTextures1;

${needs_flat}in ${int} currentBuffer;
${needs_flat}in ${int} currentLine;
${needs_flat}in ${int} texNr;
${needs_flat}in ${int} lineX;
${needs_flat}in ${int} stepSize;

layout(location = 0) out vec4 outColor0;
layout(location = 1) out vec4 outColor1;

void main(void) {
  vec2 sampleValue;
  vec2 sampleValuePrev;
  if (int(texNr) == 0) {
    sampleValuePrev = texelFetch(sampleTextures0,
      ivec3( max(int(lineX)-1,0),
             currentLine,
             currentBuffer), 0).rg;
    sampleValue = texelFetch(sampleTextures0,
      ivec3( lineX,
             currentLine,
             currentBuffer), 0).rg;
  } else {
    sampleValuePrev = texelFetch(sampleTextures1,
      ivec3( max(int(lineX)-1,0),
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
}`,
"DFT": /*glsl*/`// #include effect4

uniform sampler2D backBufferIn;
uniform int processCount;

${needs_flat}in ${int} backBufferIx;

const int bufW2 = bufferWidth * 2;

vec4 effectMain(void) {
  if (time<0.0) {
    return vec4(0.0);
  }

  float n = round(pixel_position.x);

  vec4 tracer = vec4(0.0);

  for (int ix = 0; ix < bufW2; ix++) {
    vec4 sampleValue = getSingleInputSample4(ix - bufferWidth);
    float progress = (float(ix) / (float(bufW2))) ;
    float cycle = n * progress;
    float phase = pi2 * cycle;
    // sampleValue *= (0.5 - 0.5 * cos(progress * pi2));
    vec2 v = vec2(cos(-phase),sin(-phase));

    tracer += vec4( v * sampleValue.x,
                    v * sampleValue.y);
  }
  return tracer / float(bufW2) * 2.0;
}
`,
"iDFT": /*glsl*/`// #include effect4

vec4 fourierMain(int offset) {
  float n = round(pixel_position.x) + float(bufferWidth - offset);

  float frequencyRatio = pow(2.0, (12.0 - pitchRange * pitch + getControl(133)) / 12.0) / 2.0;

  vec2 sampleValue= vec2(0.0);
  for (int ix = 0; ix < bufferWidth; ix++) {
    vec4 fourierValue = getSingleInputSample4(ix - (bufferWidth - offset));
    float progress = (n / float(bufferWidth*2));
    float phase = (float(ix))//+round(10.0+pitch*10.0))
                * pi2
                * progress * frequencyRatio;

    vec2 v = vec2(cos(phase),sin(phase)) * (0.5 - 0.5 * cos(progress * pi2));
    sampleValue += fourierValue.xz * v.x- fourierValue.yw * v.y;
  }
  return vec4(sampleValue ,0.0,1.0);
}

vec4 effectMain(void) {
  if (time<0.0) {
    return vec4(0.0);
  }
  return
    fourierMain(0) +
    fourierMain(bufferWidth);
}
`,
"DFT2": /*glsl*/`// #include effect4

uniform sampler2D backBufferIn;
uniform int processCount;

${needs_flat}in ${int} backBufferIx;

const int bufWH = bufferWidth / 2;

vec4 effectMain(void) {
  if (time<0.0) {
    return vec4(0.0);
  }

  int pp = int(round(pixel_position.x));
  int buf_n = pp / bufWH;
  int buf_ofs = bufWH * (1- buf_n);
  float n = float(pp % bufWH);

  vec4 tracer = vec4(0.0);

  for (int ix = 0; ix < bufferWidth; ix++) {
    vec4 sampleValue = getSingleInputSample4(ix - buf_ofs);
    float progress = float(ix) / float(bufferWidth);
    float cycle = n * progress;
    float phase = pi2 * cycle;
    // sampleValue *= (0.5 - 0.5 * cos(progress * pi2));
    vec2 v = vec2(cos(-phase),sin(-phase));

    tracer += vec4( v * sampleValue.x,
                    v * sampleValue.y);
  }
  // TODO: Find out why 0.9095969196112138 is necessary for correct volume
  return tracer / float(bufferWidth) * 2.0;// * 0.9095969196112138;
}
`,
"iDFT2": /*glsl*/`// #include effect4
const int bufWH = bufferWidth / 2;

vec4 fourierMain(int pos, int offset) {
  float n = float(pos); // round(pixel_position.x);// + float(bufWH - offset);
  float frequencyRatio = pow(2.0, (12.0 - pitchRange * pitch + getControl(133)) / 12.0) / 2.0;

  vec2 sampleValue= vec2(0.0);
  for (int ix = 0; ix < bufWH; ix++) {
    vec4 fourierValue = getSingleInputSample4(ix + offset);
    float progress = (n / float(bufferWidth));
    float phase = (float(ix))//+round(10.0+pitch*10.0))
                * pi2
                * progress * frequencyRatio;

    vec2 v = vec2(cos(phase),sin(phase)) * (0.5 - 0.5 * cos(progress * pi2));
    sampleValue += fourierValue.xz * v.x- fourierValue.yw * v.y;
  }
  return vec4(sampleValue ,0.0,1.0);
}

vec4 effectMain(void) {
  if (time<0.0) {
    return vec4(0.0);
  }
  int n = int(round(pixel_position.x));// + float(bufWH - offset);
  vec4 res = fourierMain(n, 0);
  if (n > bufWH) {
    return (fourierMain(n - bufWH, bufWH) + res);
  } else {
    return (fourierMain(n + bufWH, -bufWH) + res);
  }
  return
    fourierMain(n, 0);
    //fourierMain(bufWH);
}
`,

// 12 34 56
//  1 23 4
//  2 34 5

//    23
//  2  3

"DFT_log": /*glsl*/`// #include effect4

uniform sampler2D backBufferIn;
uniform int processCount;

${needs_flat}in ${int} backBufferIx;

const int bufW2 = bufferWidth * 2;
const float lowestFreq = float(sampleRate) / float(bufW2);

vec4 effectMain(void) {
  if (time<0.0) {
    return vec4(0.0);
  }

  float note = round(pixel_position.x) / float(bufferWidth) * 128.0;
  float f = 8.175798915643707 * pow(2.0, note / 12.0);
  float f2 = 8.175798915643707 * pow(2.0, (note+1.0) / 12.0);
  float n = f / lowestFreq;

  vec4 tracer = vec4(0.0);

  for (int ix = 0; ix < bufW2; ix++) {
    vec4 sampleValue = getSingleInputSample4(ix - bufferWidth);
    float progress = (float(ix) / (float(bufW2))) ;
    float cycle = n * progress;
    float phase = pi2 * cycle;
    sampleValue *= (0.5 - 0.5 * cos(progress * pi2));
    vec2 v = vec2(cos(-phase),sin(-phase));

    tracer += vec4( v * sampleValue.x,
                    v * sampleValue.y);//  * (f2-f)*0.01;
  }
  return tracer / float(bufW2);
}
`,
"DFT_log_8": /*glsl*/`// #include effect4
// #outputCount 8

uniform sampler2D backBufferIn;
uniform int processCount;

${needs_flat}in ${int} backBufferIx;

const int bufW2 = bufferWidth * 2;
const float lowestFreq = float(sampleRate) / float(bufW2);

vec4 effectMain(void) {
  if (time<0.0) {
    return vec4(0.0);
  }

  float note = round(pixel_position.x) / float(bufferWidth) * 128.0;
  float f = 8.175798915643707 * pow(2.0, note / 12.0);
  float f2 = 8.175798915643707 * pow(2.0, (note+1.0) / 12.0);
  float n = f / lowestFreq;
  int extraOffset = bufferWidth / 8 * (7 + int(backBufferIx));

  vec4 tracer = vec4(0.0);
  vec4 tracerCenter = vec4(0.0);
  int sampleWidth = bufW2; // int(round(float(bufW2) / binsPerNote));

  for (int ix = 0; ix < sampleWidth; ix++) {
    vec4 sampleValue = getSingleInputSample4(ix - sampleWidth - extraOffset);//bufferWidth);
    float progress = (float(ix) / (float(sampleWidth)));
    float cycle = n * progress;
    float phase = pi2 * cycle;
    sampleValue *= (0.5 - 0.5 * cos(clamp(progress*1.0 - 0.0,0.0,1.0) * pi2));
    vec2 v = vec2(cos(-phase),sin(-phase));

    tracer += vec4( v * sampleValue.x,
                    v * sampleValue.y);//  * (f2-f)*0.01;
  }
  return tracer / float(sampleWidth) * 1.0;
}
`,
"DFT_log_analyze": /*glsl*/`// #include effect4

uniform sampler2D backBufferIn;
uniform int processCount;

${needs_flat}in ${int} backBufferIx;

const int bufW2 = bufferWidth * 2;

vec4 effectMain(void) {
  if (time<0.0) {
    return vec4(0.0);
  }

  float binsPerNote = float(bufferWidth) / 128.0;
  float note = round(pixel_position.x) / float(bufferWidth) * 128.0;
  float f = 8.175798915643707 * pow(2.0, note / 12.0);
  float f2 = 8.175798915643707 * pow(2.0, (note+1.0) / 12.0);
  // float history = abs(fract(note) * 2.0 - 1.0);
  // if (mod(float(trackLineInfo.z),2.0)<0.99) {
  //   history = 1.0 - history;
  // }

  float history = fract(note * 2.0+ 1.5);
  int extraOffset = int(floor(history * float(bufferWidth)));

  // float samplesPerCycle = min(float(sampleRate) / f,float(bufW2));
  // float sWidth = max(samplesPerCycle, round(float(bufW2 / 4)));
  // float divider = sWidth;

  // sWidth -= mod(sWidth, samplesPerCycle);
  // sWidth /= float(bufW2 * 2);
  // samplesPerCycle /= float(bufW2);
  // extraOffset += int(round((float(bufW2) - sWidth)) * 0.5);

  int sampleWidth = bufW2; // int(round(float(bufW2) / binsPerNote));

  float lowestFreq = float(sampleRate) / float(sampleWidth);
  float n = f / lowestFreq;

  vec4 tracer = vec4(0.0);
  for (int ix = 0; ix < sampleWidth; ix++) {
    vec4 sampleValue = getSingleInputSample4(ix - sampleWidth- extraOffset);//bufferWidth);
    float progress = (float(ix) / (float(sampleWidth))) ;
    float cycle = n * progress;
    float phase = pi2 * cycle;
    sampleValue *= (0.5 - 0.5 * cos(progress * pi2));
    // sampleValue *= pow((0.5 - 0.5 * cos(progress * pi2)), 0.25 + (note / 48.0));
    // sampleValue *= 1.0-smoothstep(sWidth,sWidth+samplesPerCycle,abs(progress-0.5));
    vec2 v = vec2(cos(-phase),sin(-phase));

    tracer += vec4( v * sampleValue.x,
                    v * sampleValue.y);
  }
  // return tracer / float(bufW2 ) / (sWidth+ 0.5 * samplesPerCycle) / 2.0;
  return tracer / float(sampleWidth);
}
`,
"iDFT_log": /*glsl*/`// #include effect4

const int bufW2 = bufferWidth * 2;
const float lowestFreq = float(sampleRate) / float(bufW2);

vec4 fourierMain(int offset) {
  float n = round(pixel_position.x) + float(bufferWidth - offset);

  vec2 sampleValue= vec2(0.0);
  for (int ix = 0; ix < bufferWidth; ix++) {
    vec4 fourierValue = getSingleInputSample4(ix - (bufferWidth - offset));
    float progress = (n / float(bufW2));
    float note = float(ix) / float(bufferWidth) * 128.0;
    float f = 8.175798915643707 * pow(2.0, note / 12.0);
    float f2 = 8.175798915643707 * pow(2.0, (note+1.0) / 12.0);
      // float n = ;
    float phase = (float(f / lowestFreq))//+round(10.0+pitch*10.0))
                  * pi2
                  * progress;

    vec2 v = vec2(cos(phase),sin(phase));// * (0.5 - 0.5 * cos(progress * pi2));
    sampleValue += (fourierValue.xz * v.x- fourierValue.yw * v.y) * (f2-f)*0.004;
  }

  return vec4(sampleValue ,0.0,1.0);
}

vec4 effectMain(void) {
  if (time<0.0) {
    return vec4(0.0);
  }
  return
    fourierMain(0) +
    fourierMain(bufferWidth);
}
`,
"silence": /*glsl*/`// #include formula
0.0`,
"sine": /*glsl*/`// #include formula
sin(phase)`,
"block": /*glsl*/`// #include formula
block(phase)`,
"saw": /*glsl*/`// #include formula
saw(phase)`,
"triangle": /*glsl*/`// #include formula
triangle(phase)`,
"none": /*glsl*/`// #include effect
vec2 effectMain(void) {
  return getInputSample(0.0);
}`,
"delay-1-buffer": /*glsl*/`// #include effect
vec2 effectMain(void) {
  return getInputSample(-float(bufferWidth) / float(sampleRate));
}`,
"delay-half-buffer": /*glsl*/`// #include effect
vec2 effectMain(void) {
  return getInputSample(-float(bufferWidth) * 0.5 / float(sampleRate));
}`,
"ms delay": /*glsl*/`// #include effect
vec2 effectMain(void) {
  return getInputSample(-0.001);
}`,
"lowpass": /*glsl*/`// #include effect
const int numSamples = 20;
vec2 effectMain(void) {
  vec2 sampleValue = vec2(0.0);
  for (int ix = 0; ix < numSamples; ix++) {
    sampleValue += getInputSample(-float(ix) * sampleTime);
  }
  return sampleValue / float(numSamples) * ((50.0+float(numSamples))/50.0);
}`,
}
export default SystemShaders
