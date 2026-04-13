import { encodeRelayerPayload, encodeServiceRequest } from "../../src/bincode.js";

const innerBytes = encodeServiceRequest({
  tag: "HttpRequest",
  method: "GET",
  url: "https://httpbin.org/bytes/1024",
  headers: [],
  body: new Uint8Array(0),
});
console.log("ServiceRequest encoded length:", innerBytes.length);
console.log("ServiceRequest hex:", [...innerBytes].map(b => b.toString(16).padStart(2, '0')).join(' '));

const payloadBytes = encodeRelayerPayload({
  tag: "AnonymousRequest",
  inner: innerBytes,
  replySurbs: [],
});
console.log("\nRelayerPayload encoded length:", payloadBytes.length);
console.log("RelayerPayload hex:", [...payloadBytes].map(b => b.toString(16).padStart(2, '0')).join(' '));
