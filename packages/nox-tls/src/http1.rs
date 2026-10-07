//! HTTP/1.1 over the TLS session: one request at a time per session, no pipelining, bounded
//! head and body. The encoder alone sets the framing and connection headers, so a caller cannot
//! desynchronise the upstream connection.

use crate::error::TlsError;

/// Sent by every worker, whatever the caller asked for (the exit's `HttpRequest` path sends the
/// same value).
pub const USER_AGENT: &str = "Nox-Proxy/1.0";

/// Request sizes padded with JSON whitespace: these buckets, then multiples of the last one.
const PAD_BUCKETS: [usize; 4] = [512, 1_024, 4_096, 16_384];

/// Longest chunk-size line accepted.
const MAX_CHUNK_LINE: usize = 1_024;

/// Caller headers the encoder drops: framing, hop-by-hop and identity fields it sets itself.
const DROPPED_REQUEST_HEADERS: [&str; 10] = [
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "te",
    "trailer",
    "upgrade",
    "expect",
    "user-agent",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequestOptions {
    /// `Connection: keep-alive` instead of `Connection: close`.
    pub keep_alive: bool,
    /// The body is JSON: pad the whole request with trailing whitespace to the next size bucket.
    pub pad_json: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HttpLimits {
    pub max_head_bytes: usize,
    pub max_headers: usize,
    pub max_body_bytes: usize,
}

/// Size a JSON request of `len` bytes is padded to.
#[must_use]
pub fn padded_len(len: usize) -> usize {
    let step = PAD_BUCKETS[PAD_BUCKETS.len() - 1];
    PAD_BUCKETS
        .iter()
        .copied()
        .find(|&bucket| len <= bucket)
        .unwrap_or_else(|| len.div_ceil(step) * step)
}

/// Encodes one request. `authority` is the `Host` value (with a port only when non-default).
pub fn encode_request(
    method: &str,
    authority: &str,
    target: &str,
    headers: &[(String, String)],
    body: &[u8],
    options: RequestOptions,
) -> Result<Vec<u8>, TlsError> {
    if method.is_empty() || !method.bytes().all(is_token_byte) {
        return Err(TlsError::HttpRequest(format!("invalid method '{method}'")));
    }
    if authority.is_empty() || authority.bytes().any(|b| b <= b' ' || b == 0x7f) {
        return Err(TlsError::HttpRequest(format!(
            "invalid authority '{authority}'"
        )));
    }
    if !target.starts_with('/') || target.bytes().any(|b| b <= b' ' || b == 0x7f) {
        return Err(TlsError::HttpRequest(format!(
            "invalid request target '{target}'"
        )));
    }

    let mut head = Vec::with_capacity(256);
    head.extend_from_slice(method.as_bytes());
    head.push(b' ');
    head.extend_from_slice(target.as_bytes());
    head.extend_from_slice(b" HTTP/1.1\r\nHost: ");
    head.extend_from_slice(authority.as_bytes());
    head.extend_from_slice(b"\r\n");
    for (name, value) in headers {
        if name.is_empty() || !name.bytes().all(is_token_byte) {
            return Err(TlsError::HttpRequest(format!(
                "invalid header name '{name}'"
            )));
        }
        if value.bytes().any(is_forbidden_value_byte) {
            return Err(TlsError::HttpRequest(format!(
                "header '{name}' has a control character in its value"
            )));
        }
        if is_dropped_request_header(name) {
            continue;
        }
        head.extend_from_slice(name.as_bytes());
        head.extend_from_slice(b": ");
        head.extend_from_slice(value.as_bytes());
        head.extend_from_slice(b"\r\n");
    }
    head.extend_from_slice(b"User-Agent: ");
    head.extend_from_slice(USER_AGENT.as_bytes());
    head.extend_from_slice(if options.keep_alive {
        b"\r\nConnection: keep-alive\r\n"
    } else {
        b"\r\nConnection: close\r\n"
    });

    let with_length = !body.is_empty() || matches!(method, "POST" | "PUT" | "PATCH");
    let pad = if options.pad_json && !body.is_empty() {
        json_padding(head.len(), body.len())
    } else {
        0
    };
    let mut out = head;
    if with_length {
        out.extend_from_slice(format!("Content-Length: {}\r\n", body.len() + pad).as_bytes());
    }
    out.extend_from_slice(b"\r\n");
    out.extend_from_slice(body);
    out.resize(out.len() + pad, b' ');
    Ok(out)
}

/// Whitespace after a JSON body that brings the whole request to the next bucket. Adding pad
/// can lengthen the Content-Length value by a digit; the loop settles in at most two rounds.
fn json_padding(head_len: usize, body_len: usize) -> usize {
    let fixed = head_len + "Content-Length: \r\n\r\n".len() + body_len;
    let total = |pad: usize| fixed + decimal_digits(body_len + pad) + pad;
    let target = padded_len(total(0));
    let mut pad = target - total(0);
    for _ in 0..2 {
        if total(pad) <= target {
            break;
        }
        pad -= total(pad) - target;
    }
    pad
}

fn decimal_digits(value: usize) -> usize {
    value.checked_ilog10().map_or(1, |log| log as usize + 1)
}

fn is_dropped_request_header(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with("proxy-") || DROPPED_REQUEST_HEADERS.contains(&lower.as_str())
}

const fn is_token_byte(b: u8) -> bool {
    matches!(b,
        b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'-' | b'.' | b'^' | b'_' | b'`'
        | b'|' | b'~' | b'0'..=b'9' | b'a'..=b'z' | b'A'..=b'Z')
}

/// CR, LF, NUL and every other control byte except tab.
const fn is_forbidden_value_byte(b: u8) -> bool {
    (b < b' ' && b != b'\t') || b == 0x7f
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    /// False when the server closes the connection after this response.
    pub keep_alive: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Framing {
    Length(usize),
    Chunked,
    UntilClose,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChunkState {
    Size,
    Data(usize),
    DataEnd,
    Trailers,
}

#[derive(Debug, Clone, Copy)]
enum State {
    Head,
    Body { framing: Framing, chunk: ChunkState },
    Done,
}

/// Incremental parser; feed plaintext as it arrives from the TLS session.
#[derive(Debug)]
pub struct ResponseParser {
    limits: HttpLimits,
    head_request: bool,
    state: State,
    buf: Vec<u8>,
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    keep_alive: bool,
}

impl ResponseParser {
    #[must_use]
    pub fn new(limits: HttpLimits, head_request: bool) -> Self {
        Self {
            limits,
            head_request,
            state: State::Head,
            buf: Vec::new(),
            status: 0,
            headers: Vec::new(),
            body: Vec::new(),
            keep_alive: true,
        }
    }

    #[must_use]
    pub fn is_complete(&self) -> bool {
        matches!(self.state, State::Done)
    }

    /// Feeds bytes; returns true once the response is complete.
    pub fn push(&mut self, data: &[u8]) -> Result<bool, TlsError> {
        if self.is_complete() {
            if data.is_empty() {
                return Ok(true);
            }
            return Err(trailing_bytes(data.len()));
        }
        self.buf.extend_from_slice(data);
        loop {
            match self.state {
                State::Head => {
                    if !self.parse_head()? {
                        return Ok(false);
                    }
                }
                State::Body { framing, chunk } => {
                    if !self.parse_body(framing, chunk)? {
                        return Ok(self.is_complete());
                    }
                }
                State::Done => {
                    if !self.buf.is_empty() {
                        return Err(trailing_bytes(self.buf.len()));
                    }
                    return Ok(true);
                }
            }
        }
    }

    /// The connection ended. A close-delimited body is complete only when the server sent
    /// close_notify; any other unfinished response is a truncation.
    pub fn finish_on_close(&mut self, close_notify: bool) -> Result<(), TlsError> {
        match self.state {
            State::Done => Ok(()),
            State::Body {
                framing: Framing::UntilClose,
                ..
            } if close_notify => {
                let pending = std::mem::take(&mut self.buf);
                self.append_body(&pending)?;
                self.keep_alive = false;
                self.state = State::Done;
                Ok(())
            }
            State::Body {
                framing: Framing::UntilClose,
                ..
            } => Err(TlsError::HttpTruncated(
                "without TLS close_notify inside a close-delimited body",
            )),
            State::Head => Err(TlsError::HttpTruncated("before the response head")),
            State::Body { .. } => Err(TlsError::HttpTruncated("inside the response body")),
        }
    }

    /// Takes the parsed response once complete.
    pub fn take_response(&mut self) -> Option<HttpResponse> {
        if !self.is_complete() {
            return None;
        }
        Some(HttpResponse {
            status: self.status,
            headers: std::mem::take(&mut self.headers),
            body: std::mem::take(&mut self.body),
            keep_alive: self.keep_alive,
        })
    }

    fn parse_head(&mut self) -> Result<bool, TlsError> {
        let mut storage = vec![httparse::EMPTY_HEADER; self.limits.max_headers];
        let mut response = httparse::Response::new(&mut storage);
        let consumed = match response.parse(&self.buf) {
            Ok(httparse::Status::Complete(n)) => n,
            Ok(httparse::Status::Partial) => {
                if self.buf.len() > self.limits.max_head_bytes {
                    return Err(TlsError::HttpTooLarge {
                        part: "head",
                        limit: self.limits.max_head_bytes,
                    });
                }
                return Ok(false);
            }
            Err(httparse::Error::TooManyHeaders) => {
                return Err(TlsError::HttpTooLarge {
                    part: "header count",
                    limit: self.limits.max_headers,
                })
            }
            Err(error) => return Err(TlsError::HttpResponse(error.to_string())),
        };
        if consumed > self.limits.max_head_bytes {
            return Err(TlsError::HttpTooLarge {
                part: "head",
                limit: self.limits.max_head_bytes,
            });
        }
        let status = response
            .code
            .ok_or_else(|| TlsError::HttpResponse("missing status code".to_string()))?;
        let version = response.version.unwrap_or(1);
        let headers: Vec<(String, String)> = response
            .headers
            .iter()
            .map(|header| {
                (
                    header.name.to_string(),
                    String::from_utf8_lossy(header.value).into_owned(),
                )
            })
            .collect();
        self.buf.drain(..consumed);

        if status == 101 {
            return Err(TlsError::HttpResponse(
                "101 Switching Protocols to a request that asked for no upgrade".to_string(),
            ));
        }
        if (100..200).contains(&status) {
            // Interim response (100 Continue, 103 Early Hints): parse the final head next.
            return Ok(true);
        }

        let connection = header_value(&headers, "connection").map(str::to_ascii_lowercase);
        self.keep_alive = match connection.as_deref() {
            Some(value) if has_token(value, "close") => false,
            Some(value) if has_token(value, "keep-alive") => true,
            _ => version >= 1,
        };

        let chunked = header_value(&headers, "transfer-encoding")
            .is_some_and(|value| has_token(&value.to_ascii_lowercase(), "chunked"));
        let length = content_length(&headers)?;
        let framing = if self.head_request || status == 204 || status == 304 {
            None
        } else if chunked {
            // Both Transfer-Encoding and Content-Length: chunked wins and the connection is not
            // reused (RFC 9112 §6.3).
            if length.is_some() {
                self.keep_alive = false;
            }
            Some(Framing::Chunked)
        } else if let Some(length) = length {
            if length > self.limits.max_body_bytes {
                return Err(TlsError::HttpTooLarge {
                    part: "body",
                    limit: self.limits.max_body_bytes,
                });
            }
            Some(Framing::Length(length))
        } else {
            self.keep_alive = false;
            Some(Framing::UntilClose)
        };

        self.status = status;
        self.headers = headers;
        self.state = match framing {
            None | Some(Framing::Length(0)) => State::Done,
            Some(framing) => State::Body {
                framing,
                chunk: ChunkState::Size,
            },
        };
        Ok(true)
    }

    /// Returns true when progress was made and parsing should continue.
    fn parse_body(&mut self, framing: Framing, chunk: ChunkState) -> Result<bool, TlsError> {
        match framing {
            Framing::Length(total) => {
                let take = (total - self.body.len()).min(self.buf.len());
                let bytes: Vec<u8> = self.buf.drain(..take).collect();
                self.append_body(&bytes)?;
                if self.body.len() == total {
                    self.state = State::Done;
                    return Ok(true);
                }
                Ok(false)
            }
            Framing::UntilClose => {
                let bytes = std::mem::take(&mut self.buf);
                self.append_body(&bytes)?;
                Ok(false)
            }
            Framing::Chunked => self.parse_chunk(chunk),
        }
    }

    fn parse_chunk(&mut self, chunk: ChunkState) -> Result<bool, TlsError> {
        match chunk {
            ChunkState::Size => {
                let Some(line_end) = find_crlf(&self.buf) else {
                    if self.buf.len() > MAX_CHUNK_LINE {
                        return Err(TlsError::HttpResponse("chunk size line too long".into()));
                    }
                    return Ok(false);
                };
                let line = String::from_utf8_lossy(&self.buf[..line_end]).into_owned();
                self.buf.drain(..line_end + 2);
                let size_text = line.split(';').next().unwrap_or_default().trim();
                if size_text.is_empty() || !size_text.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(TlsError::HttpResponse(format!(
                        "invalid chunk size '{size_text}'"
                    )));
                }
                let size = usize::from_str_radix(size_text, 16).map_err(|_| {
                    TlsError::HttpResponse(format!("invalid chunk size '{size_text}'"))
                })?;
                let next = if size == 0 {
                    ChunkState::Trailers
                } else {
                    if self.body.len().saturating_add(size) > self.limits.max_body_bytes {
                        return Err(TlsError::HttpTooLarge {
                            part: "body",
                            limit: self.limits.max_body_bytes,
                        });
                    }
                    ChunkState::Data(size)
                };
                self.set_chunk(next);
                Ok(true)
            }
            ChunkState::Data(remaining) => {
                if self.buf.is_empty() {
                    return Ok(false);
                }
                let take = remaining.min(self.buf.len());
                let bytes: Vec<u8> = self.buf.drain(..take).collect();
                self.append_body(&bytes)?;
                let left = remaining - take;
                self.set_chunk(if left == 0 {
                    ChunkState::DataEnd
                } else {
                    ChunkState::Data(left)
                });
                Ok(true)
            }
            ChunkState::DataEnd => {
                if self.buf.len() < 2 {
                    return Ok(false);
                }
                if &self.buf[..2] != b"\r\n" {
                    return Err(TlsError::HttpResponse(
                        "chunk data not followed by CRLF".into(),
                    ));
                }
                self.buf.drain(..2);
                self.set_chunk(ChunkState::Size);
                Ok(true)
            }
            ChunkState::Trailers => {
                let Some(line_end) = find_crlf(&self.buf) else {
                    if self.buf.len() > self.limits.max_head_bytes {
                        return Err(TlsError::HttpTooLarge {
                            part: "trailers",
                            limit: self.limits.max_head_bytes,
                        });
                    }
                    return Ok(false);
                };
                self.buf.drain(..line_end + 2);
                if line_end == 0 {
                    self.state = State::Done;
                }
                Ok(true)
            }
        }
    }

    fn set_chunk(&mut self, chunk: ChunkState) {
        self.state = State::Body {
            framing: Framing::Chunked,
            chunk,
        };
    }

    fn append_body(&mut self, bytes: &[u8]) -> Result<(), TlsError> {
        if self.body.len().saturating_add(bytes.len()) > self.limits.max_body_bytes {
            return Err(TlsError::HttpTooLarge {
                part: "body",
                limit: self.limits.max_body_bytes,
            });
        }
        self.body.extend_from_slice(bytes);
        Ok(())
    }
}

/// The Content-Length value; repeated fields must agree (RFC 9110 §8.6).
fn content_length(headers: &[(String, String)]) -> Result<Option<usize>, TlsError> {
    let mut found: Option<usize> = None;
    for (_, value) in headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
    {
        for part in value.split(',') {
            let text = part.trim();
            if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
                return Err(TlsError::HttpResponse(format!(
                    "invalid Content-Length '{value}'"
                )));
            }
            let length: usize = text
                .parse()
                .map_err(|_| TlsError::HttpResponse(format!("invalid Content-Length '{value}'")))?;
            if found.is_some_and(|previous| previous != length) {
                return Err(TlsError::HttpResponse(
                    "conflicting Content-Length values".into(),
                ));
            }
            found = Some(length);
        }
    }
    Ok(found)
}

fn has_token(value: &str, token: &str) -> bool {
    value.split(',').any(|item| item.trim() == token)
}

fn header_value<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

fn find_crlf(data: &[u8]) -> Option<usize> {
    data.windows(2).position(|w| w == b"\r\n")
}

fn trailing_bytes(len: usize) -> TlsError {
    TlsError::HttpResponse(format!("{len} unexpected bytes after a complete response"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIMITS: HttpLimits = HttpLimits {
        max_head_bytes: 65_536,
        max_headers: 128,
        max_body_bytes: 16 * 1024 * 1024,
    };
    const CLOSE: RequestOptions = RequestOptions {
        keep_alive: false,
        pad_json: false,
    };

    fn parse_all(chunks: &[&[u8]]) -> Result<HttpResponse, TlsError> {
        let mut parser = ResponseParser::new(LIMITS, false);
        for chunk in chunks {
            parser.push(chunk)?;
        }
        parser
            .take_response()
            .ok_or(TlsError::HttpTruncated("in test"))
    }

    fn header(name: &str, value: &str) -> (String, String) {
        (name.to_string(), value.to_string())
    }

    #[test]
    fn encoder_sets_framing_and_drops_caller_framing_and_hop_by_hop_headers() {
        let headers = vec![
            header("Content-Type", "application/json"),
            header("X-Dup", "1"),
            header("Host", "evil.example"),
            header("Content-Length", "999"),
            header("Transfer-Encoding", "chunked"),
            header("Connection", "keep-alive"),
            header("Keep-Alive", "timeout=5"),
            header("TE", "trailers"),
            header("Trailer", "X"),
            header("Upgrade", "h2c"),
            header("Expect", "100-continue"),
            header("Proxy-Authorization", "x"),
            header("User-Agent", "wallet/1"),
            header("X-Dup", "2"),
        ];
        let bytes =
            encode_request("POST", "rpc.example", "/v1?k=1", &headers, b"{}", CLOSE).unwrap();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            "POST /v1?k=1 HTTP/1.1\r\nHost: rpc.example\r\nContent-Type: application/json\r\n\
             X-Dup: 1\r\nX-Dup: 2\r\nUser-Agent: Nox-Proxy/1.0\r\nConnection: close\r\n\
             Content-Length: 2\r\n\r\n{}"
        );
        let get = encode_request(
            "GET",
            "h",
            "/",
            &[],
            b"",
            RequestOptions {
                keep_alive: true,
                pad_json: false,
            },
        )
        .unwrap();
        assert!(String::from_utf8(get)
            .unwrap()
            .ends_with("Connection: keep-alive\r\n\r\n"));
    }

    #[test]
    fn encoder_refuses_injection_and_bad_targets() {
        for value in ["1\r\nX-B: 2", "1\nX", "a\0b"] {
            let headers = vec![header("X-A", value)];
            let err = encode_request("GET", "h", "/", &headers, b"", CLOSE).unwrap_err();
            assert_eq!(err.code(), "HTTP_REQUEST_INVALID");
        }
        assert!(encode_request("GET", "h", "/", &[header("X\rA", "1")], b"", CLOSE).is_err());
        assert!(encode_request("GET", "h", "nopath", &[], b"", CLOSE).is_err());
        assert!(encode_request("GE T", "h", "/", &[], b"", CLOSE).is_err());
        assert!(encode_request("GET", "h\r\n", "/", &[], b"", CLOSE).is_err());
    }

    #[test]
    fn json_padding_fills_the_whole_request_to_its_bucket() {
        let options = RequestOptions {
            keep_alive: false,
            pad_json: true,
        };
        let headers = vec![header("Content-Type", "application/json")];
        for body_len in [2usize, 100, 400, 700, 3_000, 9_990, 20_000, 70_000] {
            let body = vec![b'1'; body_len];
            let bytes =
                encode_request("POST", "rpc.example", "/", &headers, &body, options).unwrap();
            let unpadded =
                encode_request("POST", "rpc.example", "/", &headers, &body, CLOSE).unwrap();
            let target = padded_len(unpadded.len());
            assert!(
                bytes.len().abs_diff(target) <= 1,
                "{body_len}: {} vs {target}",
                bytes.len()
            );
            let text = String::from_utf8(bytes).unwrap();
            let (head, rest) = text.split_once("\r\n\r\n").unwrap();
            let declared: usize = head
                .lines()
                .find_map(|line| line.strip_prefix("Content-Length: "))
                .unwrap()
                .parse()
                .unwrap();
            assert_eq!(declared, rest.len());
            assert!(rest[body_len..].bytes().all(|b| b == b' '));
        }
        assert_eq!(padded_len(1), 512);
        assert_eq!(padded_len(513), 1_024);
        assert_eq!(padded_len(16_385), 32_768);
    }

    #[test]
    fn parses_content_length_and_chunked_split_across_pushes() {
        let response = parse_all(&[
            b"HTTP/1.1 200 OK\r\nContent-Le",
            b"ngth: 5\r\nContent-Type: application/json\r\n\r\nhe",
            b"llo",
        ])
        .unwrap();
        assert_eq!(
            (response.status, response.body.as_slice()),
            (200, &b"hello"[..])
        );
        assert!(response.keep_alive);

        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4;ext=1\r\nWiki\r\n5\r\npedia\r\n0\r\nX-T: t\r\n\r\n";
        let mut parser = ResponseParser::new(LIMITS, false);
        let mut complete = false;
        for byte in raw {
            complete = parser.push(std::slice::from_ref(byte)).unwrap();
        }
        assert!(complete);
        assert_eq!(parser.take_response().unwrap().body, b"Wikipedia");
    }

    #[test]
    fn interim_responses_are_skipped_and_101_is_refused() {
        let response = parse_all(&[
            b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 103 Early Hints\r\nLink: x\r\n\r\nHTTP/1.1 201 Created\r\nContent-Length: 0\r\n\r\n",
        ])
        .unwrap();
        assert_eq!(response.status, 201);
        assert!(parse_all(&[b"HTTP/1.1 101 Switching Protocols\r\n\r\n"]).is_err());
    }

    #[test]
    fn content_length_with_transfer_encoding_uses_chunked_and_ends_the_session() {
        let response = parse_all(&[
            b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n",
        ])
        .unwrap();
        assert_eq!(response.body, b"abc");
        assert!(!response.keep_alive);
        assert!(
            parse_all(&[b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n"])
                .is_err()
        );
        assert!(parse_all(&[b"HTTP/1.1 200 OK\r\nContent-Length: +1\r\n\r\n"]).is_err());
    }

    #[test]
    fn close_delimited_body_needs_close_notify() {
        let raw: &[u8] = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\npartial";
        let mut parser = ResponseParser::new(LIMITS, false);
        assert!(!parser.push(raw).unwrap());
        assert_eq!(
            parser.finish_on_close(false).unwrap_err().code(),
            "HTTP_RESPONSE_TRUNCATED"
        );

        let mut parser = ResponseParser::new(LIMITS, false);
        parser.push(raw).unwrap();
        parser.finish_on_close(true).unwrap();
        let response = parser.take_response().unwrap();
        assert_eq!(response.body, b"partial");
        assert!(!response.keep_alive);
    }

    #[test]
    fn truncation_is_reported_whatever_the_close() {
        let mut parser = ResponseParser::new(LIMITS, false);
        parser
            .push(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc")
            .unwrap();
        assert_eq!(
            parser.finish_on_close(true).unwrap_err().code(),
            "HTTP_RESPONSE_TRUNCATED"
        );
        let mut empty = ResponseParser::new(LIMITS, false);
        assert_eq!(
            empty.finish_on_close(true).unwrap_err().code(),
            "HTTP_RESPONSE_TRUNCATED"
        );
    }

    #[test]
    fn limits_are_enforced() {
        let limits = HttpLimits {
            max_head_bytes: 64,
            max_headers: 4,
            max_body_bytes: 4,
        };
        let mut parser = ResponseParser::new(limits, false);
        let err = parser
            .push(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n")
            .unwrap_err();
        assert_eq!(err.code(), "HTTP_RESPONSE_TOO_LARGE");
        let mut parser = ResponseParser::new(limits, false);
        let err = parser
            .push(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n9\r\n")
            .unwrap_err();
        assert_eq!(err.code(), "HTTP_RESPONSE_TOO_LARGE");
        let mut parser = ResponseParser::new(limits, false);
        let long_head = format!("HTTP/1.1 200 OK\r\nX: {}\r\n", "a".repeat(100));
        assert_eq!(
            parser.push(long_head.as_bytes()).unwrap_err().code(),
            "HTTP_RESPONSE_TOO_LARGE"
        );
    }

    #[test]
    fn bodiless_responses_and_trailing_garbage() {
        let mut parser = ResponseParser::new(LIMITS, true);
        assert!(parser
            .push(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n")
            .unwrap());
        assert!(parse_all(&[b"HTTP/1.1 204 No Content\r\n\r\n"])
            .unwrap()
            .body
            .is_empty());
        let mut parser = ResponseParser::new(LIMITS, false);
        let err = parser
            .push(b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nab")
            .unwrap_err();
        assert_eq!(err.code(), "HTTP_RESPONSE_MALFORMED");
        assert!(
            !parse_all(&[b"HTTP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n"])
                .unwrap()
                .keep_alive
        );
    }
}
