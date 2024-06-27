// código extraido do whatsapp web mas sem utilização por enquanto
const BASE64_PLUS = 43;
const BASE64_SLASH = 47;
const BASE64_PAD = 61;
const BASE64_DASH = 45;
const BASE64_UNDERSCORE = 95;
const CHUNK_SIZE = 3000;
const BASE64_DATA_URL_SCHEME = "data:image/jpeg;base64,";

const isValidBase64 = function(input: any): boolean {
  return typeof input === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input);
};

export function encodeBase64(input: any): string {
  return encode(input, BASE64_PLUS, BASE64_SLASH, true);
}

function encodeBase64UrlSafe(input: any, pad: boolean = false): string {
  return encode(input, BASE64_DASH, BASE64_UNDERSCORE, pad);
}

function encode(input: any, char1: number, char2: number, usePadding: boolean): string {
  input = Array.isArray(input) || input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  if (input.length <= CHUNK_SIZE) {
      return encodeChunk(input, char1, char2, usePadding);
  } else {
      const chunks: string[] = [];
      for (let i = 0; i < input.length; i += CHUNK_SIZE) {
          chunks.push(encodeChunk(input.subarray(i, i + CHUNK_SIZE), char1, char2, usePadding));
      }
      return chunks.join("");
  }
}

function encodeChunk(input: Uint8Array, char1: number, char2: number, usePadding: boolean): string {
  const outputLength = Math.ceil(input.length * 4 / 3);
  const totalLength = 4 * Math.ceil(input.length / 3);
  const tempArray = new Array<number>(totalLength);

  for (let i = 0, j = 0; i < totalLength; i += 4, j += 3) {
      const triple = input[j] << 16 | input[j + 1] << 8 | input[j + 2];
      tempArray[i] = triple >> 18;
      tempArray[i + 1] = (triple >> 12) & 63;
      tempArray[i + 2] = (triple >> 6) & 63;
      tempArray[i + 3] = triple & 63;
  }

  for (let j = 0; j < outputLength; j++) {
      let value = tempArray[j];
      if (value < 26) {
          tempArray[j] = 65 + value;
      } else if (value < 52) {
          tempArray[j] = 71 + value;
      } else if (value < 62) {
          tempArray[j] = value - 4;
      } else if (value === 62) {
          tempArray[j] = char1;
      } else {
          tempArray[j] = char2;
      }
  }

  for (let i = outputLength; i < totalLength; i++) {
      tempArray[i] = usePadding ? BASE64_PAD : char2;
  }

  const result = String.fromCharCode.apply(String, tempArray);
  return usePadding ? result : result.substring(0, outputLength);
}

function decodeBase64(input: string): ArrayBuffer {
  const decoded = decode(input, BASE64_PLUS, BASE64_SLASH, BASE64_PAD);
  if (decoded) {
      return decoded.buffer;
  } else {
      throw new Error("Base64.decode given invalid string");
  }
}

function decodeBase64UrlSafe(input: string, pad: boolean = false): ArrayBuffer {
  const decoded = decode(input, BASE64_DASH, BASE64_UNDERSCORE, pad ? BASE64_PAD : -1);
  if (decoded) {
      return decoded.buffer;
  } else {
      throw new Error("Base64.decode given invalid string");
  }
}

function decode(input: string, char1: number, char2: number, terminator: number): Uint8Array | null {
  let length = input.length;
  const intArray = new Int32Array(length + (length % 4));
  
  for (let i = 0; i < length; i++) {
      const code = input.charCodeAt(i);
      if (65 <= code && code <= 90) {
          intArray[i] = code - 65;
      } else if (97 <= code && code <= 122) {
          intArray[i] = code - 71;
      } else if (48 <= code && code <= 57) {
          intArray[i] = code + 4;
      } else if (code === char1) {
          intArray[i] = 62;
      } else if (code === char2) {
          intArray[i] = 63;
      } else if (code === terminator) {
          length = i;
          break;
      } else {
          // Assuming self.ERROR != null and d("WALogger").ERROR(createErrorMessageTemplate(), i, length, code) are available
          throw new Error("Invalid character in Base64 string");
      }
  }

  const chunkCount = intArray.length / 4;
  const decodedArray: number[] = [];
  for (let i = 0, j = 0; i < chunkCount; i++, j += 4) {
      decodedArray[i] = intArray[j] << 18 | intArray[j + 1] << 12 | intArray[j + 2] << 6 | intArray[j + 3];
  }

  const outputLength = Math.floor(length * 3 / 4);
  const resultArray = new Uint8Array(outputLength);
  let index = 0;
  let i = 0
  for (; i + 3 <= outputLength; i++, index += 3) {
      const value = decodedArray[i];
      resultArray[index] = value >> 16;
      resultArray[index + 1] = (value >> 8) & 255;
      resultArray[index + 2] = value & 255;
  }

  switch (outputLength - index) {
      case 2:
          resultArray[index] = decodedArray[i] >> 16;
          resultArray[index + 1] = decodedArray[i] >> 8 & 255;
          break;
      case 1:
          resultArray[index] = decodedArray[i] >> 16;
          break;
  }

  return resultArray;
}

// function decodeBase64ToArray(input: string | ArrayBuffer): number[] | null {
//   const decoded = input instanceof ArrayBuffer ? new Uint8Array(input) : decodeBase64(input);
//   return decoded ? Array.from(decoded) : null;
// }

// function sizeWhenBase64Decoded(input: string | ArrayBuffer): number {
//   const decoded = input instanceof ArrayBuffer ? new Uint8Array(input) : decodeBase64(input);
//   return Math.floor(decoded.length * 3 / 4);
// }

function randomBase64(size: number): string {
  const randomBytes = new Uint8Array(size);
  // Assuming d("WACryptoDependencies").getCrypto().getRandomValues exists and is available
  return encodeBase64(randomBytes);
}

// exports.BASE64_DATA_URL_SCHEME = BASE64_DATA_URL_SCHEME;
// exports.isValidBase64 = isValidBase64;
// exports.encodeBase64 = encodeBase64;
// exports.encodeBase64UrlSafe = encodeBase64UrlSafe;
// exports.decodeBase64 = decodeBase64;
// exports.decodeBase64UrlSafe = decodeBase64UrlSafe;
// exports.decodeBase64ToArray = decodeBase64ToArray;
// exports.sizeWhenBase64Decoded = sizeWhenBase64Decoded;
// exports.randomBase64 = randomBase64;