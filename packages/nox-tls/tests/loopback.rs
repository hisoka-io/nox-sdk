//! The sans-IO client against an in-memory rustls server, one `exchange` per tunnel round trip.

mod support;

use nox_tls::{encode_request, HttpLimits, RequestOptions, ResponseParser, TlsSession};
use support::{
    client, read_client_hello, server_config, Framing, Upstream, Versions, CA, EC_CERT, EC_KEY,
    EXPIRED_CERT, EXPIRED_KEY, EXT_EARLY_DATA, EXT_PRE_SHARED_KEY, REPLY, RSA_CERT, RSA_KEY,
    UNTRUSTED_CERT, UNTRUSTED_KEY,
};

const LIMITS: HttpLimits = HttpLimits {
    max_head_bytes: 65_536,
    max_headers: 128,
    max_body_bytes: 1 << 20,
};
const BODY: &[u8] = br#"{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}"#;

/// Handshake (if needed) and one POST in lockstep exchanges. Returns the exchanges used and
/// the parser after the last one.
fn post(
    session: &mut TlsSession,
    upstream: &mut Upstream,
    keep_alive: bool,
) -> (usize, ResponseParser) {
    let start = upstream.exchanges;
    let options = RequestOptions {
        keep_alive,
        pad_json: true,
    };
    let headers = [("Content-Type".to_string(), "application/json".to_string())];
    let request = encode_request("POST", "rpc.nox.test", "/", &headers, BODY, options).unwrap();
    session.write_plaintext(&request).unwrap();
    let mut parser = ResponseParser::new(LIMITS, false);
    loop {
        let outgoing = session.take_outgoing().unwrap();
        let reply = upstream.exchange(&outgoing).unwrap();
        if reply.is_empty() {
            break;
        }
        session.push_incoming(&reply).unwrap();
        if parser.push(&session.take_plaintext()).unwrap() || session.is_closed() {
            break;
        }
        assert!(
            upstream.exchanges - start < 6,
            "no progress after 6 exchanges"
        );
    }
    (upstream.exchanges - start, parser)
}

fn body_of(mut parser: ResponseParser) -> Vec<u8> {
    parser.take_response().unwrap().body
}

#[test]
fn tls13_handshake_and_request_take_two_exchanges_then_keep_alive_takes_one() {
    let mut upstream = Upstream::new(server_config(EC_CERT, EC_KEY, Versions::Both));
    let mut session = client("rpc.nox.test");
    let (exchanges, parser) = post(&mut session, &mut upstream, true);
    assert_eq!(exchanges, 2, "ClientHello, then Finished with the request");
    assert_eq!(body_of(parser), REPLY);
    assert_eq!(session.protocol(), "TLSv1_3");
    for _ in 0..3 {
        let (exchanges, parser) = post(&mut session, &mut upstream, true);
        assert_eq!(exchanges, 1);
        assert_eq!(body_of(parser), REPLY);
    }
}

#[test]
fn rsa_chain_verifies_and_tls12_costs_one_more_exchange() {
    let mut upstream = Upstream::new(server_config(RSA_CERT, RSA_KEY, Versions::Both));
    let mut session = TlsSession::new(
        nox_tls::build_client_config(false, &[CA.to_vec()]).unwrap(),
        "rsa.nox.test",
    )
    .unwrap();
    let (exchanges, _) = post(&mut session, &mut upstream, false);
    assert_eq!(exchanges, 2);

    let mut upstream = Upstream::new(server_config(EC_CERT, EC_KEY, Versions::Tls12Only));
    let mut session = client("rpc.nox.test");
    let (exchanges, parser) = post(&mut session, &mut upstream, false);
    assert_eq!(exchanges, 3);
    assert_eq!(body_of(parser), REPLY);
    assert_eq!(session.protocol(), "TLSv1_2");
}

fn rejected(cert: &[u8], key: &[u8], host: &str) -> nox_tls::TlsError {
    let mut upstream = Upstream::new(server_config(cert, key, Versions::Both));
    let mut session = client(host);
    let hello = session.take_outgoing().unwrap();
    let flight = upstream.exchange(&hello).unwrap();
    let err = session.push_incoming(&flight).unwrap_err();
    // An alert is queued for the server; no application data ever leaves.
    assert!(!session.take_outgoing().unwrap().is_empty());
    err
}

#[test]
fn wrong_name_untrusted_root_and_expired_certificates_are_rejected() {
    let wrong = rejected(EC_CERT, EC_KEY, "other.nox.test");
    assert_eq!(wrong.code(), "TLS_CERTIFICATE_REJECTED");
    assert!(wrong.to_string().contains("not valid for name"), "{wrong}");

    let untrusted = rejected(UNTRUSTED_CERT, UNTRUSTED_KEY, "rpc.nox.test");
    assert_eq!(untrusted.code(), "TLS_CERTIFICATE_REJECTED");
    assert!(
        untrusted
            .to_string()
            .to_ascii_lowercase()
            .contains("unknownissuer"),
        "{untrusted}"
    );

    let expired = rejected(EXPIRED_CERT, EXPIRED_KEY, "expired.nox.test");
    assert_eq!(expired.code(), "TLS_CERTIFICATE_REJECTED");
    assert!(expired.to_string().contains("device clock"), "{expired}");
}

#[test]
fn tampered_records_fail_authentication() {
    let mut upstream = Upstream::new(server_config(EC_CERT, EC_KEY, Versions::Both));
    let mut session = client("rpc.nox.test");
    let hello = session.take_outgoing().unwrap();
    upstream.tamper_next_reply = true;
    let flight = upstream.exchange(&hello).unwrap();
    assert_eq!(
        session.push_incoming(&flight).unwrap_err().code(),
        "TLS_DECRYPT_FAILED"
    );
}

#[test]
fn close_delimited_body_is_complete_only_with_close_notify() {
    for close_notify in [true, false] {
        let mut upstream = Upstream::new(server_config(EC_CERT, EC_KEY, Versions::Both));
        upstream.framing = Framing::UntilClose { close_notify };
        let mut session = client("rpc.nox.test");
        let (_, mut parser) = post(&mut session, &mut upstream, false);
        // The exit reports EOF; only close_notify proves the server ended the body.
        session.push_transport_eof().unwrap();
        parser.push(&session.take_plaintext()).unwrap();
        let result = parser.finish_on_close(session.close_notify_received());
        if close_notify {
            result.unwrap();
            assert_eq!(body_of(parser), REPLY);
        } else {
            assert_eq!(result.unwrap_err().code(), "HTTP_RESPONSE_TRUNCATED");
        }
    }
}

#[test]
fn client_hello_offers_http11_only_and_never_a_psk() {
    let config = nox_tls::build_client_config(false, &[CA.to_vec()]).unwrap();
    let mut first = TlsSession::new(config.clone(), "rpc.nox.test").unwrap();
    let mut upstream = Upstream::new(server_config(EC_CERT, EC_KEY, Versions::Both));
    let _ = post(&mut first, &mut upstream, true);
    // The server issued tickets during the first session; the second must not offer them.
    let mut second = TlsSession::new(config, "rpc.nox.test").unwrap();
    for hello in [
        read_client_hello(&client("rpc.nox.test").take_outgoing().unwrap()),
        read_client_hello(&second.take_outgoing().unwrap()),
    ] {
        assert_eq!(hello.server_name.as_deref(), Some("rpc.nox.test"));
        assert_eq!(hello.alpn, ["http/1.1"]);
        assert!(!hello.extensions.contains(&EXT_PRE_SHARED_KEY));
        assert!(!hello.extensions.contains(&EXT_EARLY_DATA));
    }
}

#[test]
fn ip_literal_server_names_are_refused() {
    let config = nox_tls::build_client_config(false, &[CA.to_vec()]).unwrap();
    let err = TlsSession::new(config, "127.0.0.1").err().unwrap();
    assert_eq!(err.code(), "TLS_INVALID_SERVER_NAME");
}

#[test]
fn compiled_in_roots_are_present() {
    assert!(nox_tls::webpki_root_count() > 100);
    assert!(nox_tls::build_client_config(true, &[]).is_ok());
    assert_eq!(
        nox_tls::build_client_config(false, &[]).unwrap_err().code(),
        "TLS_CONFIG"
    );
    assert_eq!(
        nox_tls::build_client_config(false, &[vec![1, 2, 3]])
            .unwrap_err()
            .code(),
        "TLS_INVALID_TRUST_ANCHOR"
    );
}
