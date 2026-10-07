//! wasm-bindgen surface for the worker. Errors are JS `Error`s with a stable `code` property.

use std::sync::Arc;

use js_sys::{Array, Object, Reflect, Uint8Array};
use rustls::ClientConfig;
use wasm_bindgen::prelude::*;

use crate::config::{build_client_config, webpki_root_count};
use crate::error::TlsError;
use crate::http1::{encode_request, HttpLimits, HttpResponse, RequestOptions, ResponseParser};
use crate::session::TlsSession;

/// Most response headers accepted.
const MAX_RESPONSE_HEADERS: usize = 128;

fn to_js(error: &TlsError) -> JsValue {
    let js_error = js_sys::Error::new(&error.to_string());
    // Setting a property on a fresh Error cannot fail; the message stays either way.
    let _ = Reflect::set(&js_error, &"code".into(), &error.code().into());
    js_error.into()
}

fn object(entries: &[(&str, JsValue)]) -> JsValue {
    let obj = Object::new();
    for (key, value) in entries {
        let _ = Reflect::set(&obj, &(*key).into(), value);
    }
    obj.into()
}

/// Client configuration shared by every session: the compiled-in roots, plus `extraRootDer`
/// in test beds only (a release worker passes `undefined`).
#[wasm_bindgen]
pub struct TlsClientConfig {
    inner: Arc<ClientConfig>,
}

#[wasm_bindgen]
impl TlsClientConfig {
    #[wasm_bindgen(constructor)]
    pub fn new(extra_root_der: Option<Vec<u8>>) -> Result<TlsClientConfig, JsValue> {
        let extra: Vec<Vec<u8>> = extra_root_der.into_iter().collect();
        let inner = build_client_config(true, &extra).map_err(|e| to_js(&e))?;
        Ok(Self { inner })
    }
}

/// One TLS session to one server, carried over a Nox tunnel by the caller.
#[wasm_bindgen]
pub struct TlsClientSession {
    inner: TlsSession,
}

#[wasm_bindgen]
impl TlsClientSession {
    #[wasm_bindgen(constructor)]
    pub fn new(config: &TlsClientConfig, server_name: &str) -> Result<TlsClientSession, JsValue> {
        let inner = TlsSession::new(config.inner.clone(), server_name).map_err(|e| to_js(&e))?;
        Ok(Self { inner })
    }

    #[wasm_bindgen(js_name = takeOutgoing)]
    pub fn take_outgoing(&mut self) -> Result<Vec<u8>, JsValue> {
        self.inner.take_outgoing().map_err(|e| to_js(&e))
    }

    #[wasm_bindgen(js_name = pushIncoming)]
    pub fn push_incoming(&mut self, data: &[u8]) -> Result<(), JsValue> {
        self.inner.push_incoming(data).map_err(|e| to_js(&e))
    }

    #[wasm_bindgen(js_name = pushTransportEof)]
    pub fn push_transport_eof(&mut self) -> Result<(), JsValue> {
        self.inner.push_transport_eof().map_err(|e| to_js(&e))
    }

    #[wasm_bindgen(js_name = isHandshaking)]
    pub fn is_handshaking(&self) -> bool {
        self.inner.is_handshaking()
    }

    #[wasm_bindgen(js_name = wantsWrite)]
    pub fn wants_write(&self) -> bool {
        self.inner.wants_write()
    }

    #[wasm_bindgen(js_name = closeNotifyReceived)]
    pub fn close_notify_received(&self) -> bool {
        self.inner.close_notify_received()
    }

    #[wasm_bindgen(js_name = isClosed)]
    pub fn is_closed(&self) -> bool {
        self.inner.is_closed()
    }

    #[wasm_bindgen(js_name = writePlaintext)]
    pub fn write_plaintext(&mut self, data: &[u8]) -> Result<(), JsValue> {
        self.inner.write_plaintext(data).map_err(|e| to_js(&e))
    }

    #[wasm_bindgen(js_name = takePlaintext)]
    pub fn take_plaintext(&mut self) -> Vec<u8> {
        self.inner.take_plaintext()
    }

    pub fn close(&mut self) {
        self.inner.close();
    }

    pub fn protocol(&self) -> String {
        self.inner.protocol()
    }
}

/// Incremental HTTP/1.1 response parser.
#[wasm_bindgen]
pub struct HttpResponseParser {
    parser: ResponseParser,
    response: Option<HttpResponse>,
}

#[wasm_bindgen]
impl HttpResponseParser {
    #[wasm_bindgen(constructor)]
    pub fn new(
        head_request: bool,
        max_head_bytes: usize,
        max_body_bytes: usize,
    ) -> HttpResponseParser {
        let limits = HttpLimits {
            max_head_bytes,
            max_headers: MAX_RESPONSE_HEADERS,
            max_body_bytes,
        };
        Self {
            parser: ResponseParser::new(limits, head_request),
            response: None,
        }
    }

    /// Returns true when the response is complete.
    pub fn push(&mut self, data: &[u8]) -> Result<bool, JsValue> {
        let complete = self.parser.push(data).map_err(|e| to_js(&e))?;
        if complete && self.response.is_none() {
            self.response = self.parser.take_response();
        }
        Ok(complete)
    }

    #[wasm_bindgen(js_name = finishOnClose)]
    pub fn finish_on_close(&mut self, close_notify: bool) -> Result<(), JsValue> {
        self.parser
            .finish_on_close(close_notify)
            .map_err(|e| to_js(&e))?;
        if self.response.is_none() {
            self.response = self.parser.take_response();
        }
        Ok(())
    }

    /// `{status, headers: [name, value][], body: Uint8Array, keepAlive}` or `null`.
    pub fn response(&self) -> JsValue {
        let Some(response) = &self.response else {
            return JsValue::NULL;
        };
        let headers = Array::new();
        for (name, value) in &response.headers {
            let pair = Array::new();
            pair.push(&name.into());
            pair.push(&value.into());
            headers.push(&pair);
        }
        object(&[
            ("status", response.status.into()),
            ("headers", headers.into()),
            ("body", Uint8Array::from(response.body.as_slice()).into()),
            ("keepAlive", response.keep_alive.into()),
        ])
    }
}

/// `headers` alternates names and values: `[name, value, name, value, ...]`.
#[wasm_bindgen(js_name = encodeHttpRequest)]
pub fn encode_http_request(
    method: &str,
    authority: &str,
    target: &str,
    headers: Vec<String>,
    body: &[u8],
    keep_alive: bool,
    pad_json: bool,
) -> Result<Vec<u8>, JsValue> {
    if !headers.len().is_multiple_of(2) {
        return Err(to_js(&TlsError::HttpRequest(format!(
            "{} header fields do not form name/value pairs",
            headers.len()
        ))));
    }
    let pairs: Vec<(String, String)> = headers
        .chunks_exact(2)
        .map(|pair| (pair[0].clone(), pair[1].clone()))
        .collect();
    let options = RequestOptions {
        keep_alive,
        pad_json,
    };
    encode_request(method, authority, target, &pairs, body, options).map_err(|e| to_js(&e))
}

/// `{crate, webpkiRoots}`.
#[wasm_bindgen(js_name = buildInfo)]
pub fn build_info() -> JsValue {
    object(&[
        ("crate", env!("CARGO_PKG_VERSION").into()),
        ("webpkiRoots", (webpki_root_count() as f64).into()),
    ])
}
