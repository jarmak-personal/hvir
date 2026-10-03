//! Transport only. The application owns every command and authorization decision.
use serde::{Deserialize, Serialize};
use socket2::{Domain, SockAddr, Socket, Type};
use std::env;
use std::io::{self, Read, Write};
#[cfg(test)]
use std::io::{BufRead, BufReader};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

const CONTRACT: &str = "1.0";
const FRAME_BYTES: usize = 256 * 1024;
const STDIN_BYTES: usize = 128 * 1024;
const DEADLINE: Duration = Duration::from_secs(191);

#[derive(Serialize)]
struct Request {
    contract: &'static str,
    argv: Vec<String>,
    stdin: String,
    defaults: Defaults,
}
#[derive(Default, Serialize)]
struct Defaults {
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session: Option<String>,
}
#[derive(Deserialize)]
struct Response {
    contract: String,
    stdout: String,
    stderr: String,
    #[serde(rename = "exitStatus")]
    exit_status: u8,
}

fn selected_endpoint(argv: &[String], inherited: Option<String>) -> Result<(String, bool), String> {
    let mut explicit = None;
    let mut index = 0;
    while index < argv.len() {
        if argv[index] == "--instance" {
            index += 1;
            explicit = Some(
                argv.get(index)
                    .ok_or("Missing --instance endpoint")?
                    .clone(),
            );
        } else if let Some(value) = argv[index].strip_prefix("--instance=") {
            explicit = Some(value.to_owned());
        }
        index += 1;
    }
    let defaults = explicit.is_none() || explicit == inherited;
    let endpoint = explicit
        .or(inherited)
        .ok_or("No hvir SSH endpoint; use an hvir terminal or select --instance")?;
    if !endpoint.starts_with('/') || endpoint.len() >= 104 || endpoint.contains('\0') {
        return Err(
            "Instance selection must be an absolute socket endpoint shorter than 104 bytes".into(),
        );
    }
    Ok((endpoint, defaults))
}

fn read_input<R: Read>(input: R) -> Result<String, String> {
    let mut bytes = Vec::new();
    input
        .take((STDIN_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read command stdin")?;
    if bytes.len() > STDIN_BYTES {
        return Err("Command stdin exceeds its bound".into());
    }
    String::from_utf8(bytes).map_err(|_| "Command stdin must be UTF-8".into())
}

fn connect(endpoint: &std::path::Path, timeout: Duration) -> io::Result<UnixStream> {
    let socket = Socket::new(Domain::UNIX, Type::STREAM, None)?;
    socket.connect_timeout(&SockAddr::unix(endpoint)?, timeout)?;
    Ok(UnixStream::from(std::os::fd::OwnedFd::from(socket)))
}
fn remaining(deadline: Instant) -> Result<Duration, String> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|value| !value.is_zero())
        .ok_or_else(|| {
            "Connection deadline ended; execution may be uncertain; request was not replayed".into()
        })
}
#[cfg(test)]
fn exchange(stream: &mut UnixStream, request: &Request) -> Result<Response, String> {
    exchange_until(stream, request, Instant::now() + DEADLINE)
}
fn exchange_until(
    stream: &mut UnixStream,
    request: &Request,
    deadline: Instant,
) -> Result<Response, String> {
    let mut frame = serde_json::to_vec(request).map_err(|_| "Could not frame command")?;
    frame.push(b'\n');
    if frame.len() > FRAME_BYTES {
        return Err("Command frame exceeds its bound".into());
    }
    let mut offset = 0;
    while offset < frame.len() {
        stream
            .set_write_timeout(Some(remaining(deadline)?))
            .map_err(|_| "Could not set request deadline")?;
        match stream.write(&frame[offset..]) {
            Ok(0) => {
                return Err(
                    "Connection interrupted; execution may be uncertain; request was not replayed"
                        .into(),
                )
            }
            Ok(bytes) => offset += bytes,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => {
                return Err(
                    "Connection interrupted; execution may be uncertain; request was not replayed"
                        .into(),
                )
            }
        }
    }
    let mut response = Vec::new();
    loop {
        stream
            .set_read_timeout(Some(remaining(deadline)?))
            .map_err(|_| "Could not set request deadline")?;
        let mut chunk = [0; 4096];
        let bytes = match stream.read(&mut chunk) {
            Ok(0) => return Err("Connection ended without a result; execution may be uncertain; request was not replayed".into()),
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Err("Connection interrupted; execution may be uncertain; request was not replayed".into()),
        };
        response.extend_from_slice(&chunk[..bytes]);
        if response.len() > FRAME_BYTES {
            return Err("Application result exceeds its framing bound".into());
        }
        if let Some(newline) = response.iter().position(|byte| *byte == b'\n') {
            if newline != response.len() - 1 {
                return Err("Application returned multiple result frames".into());
            }
            break;
        }
    }
    let value: Response = serde_json::from_slice(&response)
        .map_err(|_| "Application returned an invalid agent contract")?;
    if value.contract != CONTRACT {
        return Err("Application returned an unsupported agent contract".into());
    }
    Ok(value)
}

fn command() -> Result<Response, String> {
    let argv: Vec<String> = env::args_os()
        .skip(1)
        .map(|arg| {
            arg.into_string()
                .map_err(|_| "Arguments must be UTF-8".to_owned())
        })
        .collect::<Result<_, _>>()?;
    let (endpoint, use_defaults) = selected_endpoint(&argv, env::var("HVIR_AGENT_ENDPOINT").ok())?;
    let stdin = if argv.iter().any(|arg| arg == "--stdin") {
        read_input(io::stdin().lock())?
    } else {
        String::new()
    };
    let request = Request {
        contract: CONTRACT,
        argv,
        stdin,
        defaults: if use_defaults {
            Defaults {
                workspace: env::var("HVIR_AGENT_WORKSPACE").ok(),
                session: env::var("HVIR_AGENT_SESSION").ok(),
            }
        } else {
            Defaults::default()
        },
    };
    let deadline = Instant::now() + DEADLINE;
    let mut stream =
        connect(std::path::Path::new(&endpoint), Duration::from_secs(8)).map_err(|_| {
            "SSH agent endpoint is unavailable; stale endpoints never select another connection"
        })?;
    exchange_until(&mut stream, &request, deadline)
}

fn main() {
    if env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--hvir-client-probe-socket"))
    {
        let status = match env::args_os()
            .nth(2)
            .map(|path| connect(std::path::Path::new(&path), Duration::from_secs(8)))
        {
            Some(Ok(_)) => {
                println!("live");
                0
            }
            Some(Err(error))
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
                ) =>
            {
                println!("stale");
                0
            }
            _ => 69,
        };
        std::process::exit(status);
    }

    // Build/staging health probe, not a command-policy implementation.
    if env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--hvir-client-probe")) {
        println!("hvir-agent transport {CONTRACT}");
        return;
    }
    let status = match command() {
        Ok(response) => {
            if io::stdout().write_all(response.stdout.as_bytes()).is_err()
                || io::stderr().write_all(response.stderr.as_bytes()).is_err()
            {
                74
            } else {
                response.exit_status
            }
        }
        Err(message) => {
            let value = serde_json::json!({"contract": CONTRACT, "ok": false, "error": {"code": "unavailable", "message": message}});
            println!("{value}");
            69
        }
    };
    std::process::exit(i32::from(status));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoint_selection_never_inherits_a_different_instances_context() {
        let argv = vec!["report".into(), "--instance".into(), "/other.sock".into()];
        assert_eq!(
            selected_endpoint(&argv, Some("/terminal.sock".into())).unwrap(),
            ("/other.sock".into(), false)
        );
        assert!(selected_endpoint(&[], None).is_err());
        assert!(selected_endpoint(&[], Some("relative".into())).is_err());
    }
    #[test]
    fn input_is_bounded_utf8() {
        assert_eq!(read_input("report 😃".as_bytes()).unwrap(), "report 😃");
        assert!(read_input(&[0xff][..]).is_err());
        assert!(read_input(vec![0; STDIN_BYTES + 1].as_slice()).is_err());
    }
    #[test]
    fn protocol_relays_unicode_streams_and_exit_status_without_command_policy() {
        let (mut client, mut server) = UnixStream::pair().unwrap();
        let thread = std::thread::spawn(move || {
            let mut line = String::new();
            BufReader::new(&mut server).read_line(&mut line).unwrap();
            let value: serde_json::Value = serde_json::from_str(&line).unwrap();
            assert_eq!(value["argv"][0], "unknown-future-command");
            assert_eq!(value["stdin"], "input 😃");
            server.write_all(b"{\"contract\":\"1.0\",\"stdout\":\"out\",\"stderr\":\"err\",\"exitStatus\":75}\n").unwrap();
        });
        let result = exchange(
            &mut client,
            &Request {
                contract: CONTRACT,
                argv: vec!["unknown-future-command".into()],
                stdin: "input 😃".into(),
                defaults: Defaults::default(),
            },
        )
        .unwrap();
        assert_eq!(
            (
                result.stdout.as_str(),
                result.stderr.as_str(),
                result.exit_status
            ),
            ("out", "err", 75)
        );
        thread.join().unwrap();
    }
    #[test]
    fn interrupted_requests_are_not_replayed() {
        let (mut client, mut server) = UnixStream::pair().unwrap();
        let thread = std::thread::spawn(move || {
            let mut line = String::new();
            BufReader::new(&mut server).read_line(&mut line).unwrap();
        });
        let error = exchange(
            &mut client,
            &Request {
                contract: CONTRACT,
                argv: vec!["run".into()],
                stdin: String::new(),
                defaults: Defaults::default(),
            },
        )
        .err()
        .unwrap();
        assert!(error.contains("not replayed"));
        thread.join().unwrap();
    }
    #[test]
    fn fragments_cannot_renew_the_absolute_exchange_deadline() {
        let (mut client, mut server) = UnixStream::pair().unwrap();
        let thread = std::thread::spawn(move || {
            let mut line = String::new();
            BufReader::new(&mut server).read_line(&mut line).unwrap();
            for _ in 0..1000 {
                if server.write_all(b" ").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
        });
        let started = Instant::now();
        let result = exchange_until(
            &mut client,
            &Request {
                contract: CONTRACT,
                argv: vec![],
                stdin: String::new(),
                defaults: Defaults::default(),
            },
            started + Duration::from_millis(20),
        );
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
        drop(client);
        thread.join().unwrap();
    }
    #[test]
    fn unix_connect_and_dead_socket_probe_are_bounded() {
        use std::os::unix::net::UnixListener;
        let path = env::temp_dir().join(format!("hvir-agent-test-{}.sock", std::process::id()));
        let listener = UnixListener::bind(&path).unwrap();
        let client = connect(&path, Duration::from_millis(20)).unwrap();
        let (_server, _) = listener.accept().unwrap();
        drop(client);
        drop(listener);
        assert!(connect(&path, Duration::from_millis(20)).is_err());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn full_unix_listen_backlog_cannot_make_connect_unbounded() {
        let path = env::temp_dir().join(format!("hvir-agent-backlog-{}.sock", std::process::id()));
        let listener = Socket::new(Domain::UNIX, Type::STREAM, None).unwrap();
        listener.bind(&SockAddr::unix(&path).unwrap()).unwrap();
        listener.listen(1).unwrap();
        let started = Instant::now();
        let mut clients = Vec::new();
        let mut bounded_failure = false;
        for _ in 0..16 {
            match connect(&path, Duration::from_millis(20)) {
                Ok(client) => clients.push(client),
                Err(_) => {
                    bounded_failure = true;
                    break;
                }
            }
        }
        assert!(bounded_failure);
        assert!(started.elapsed() < Duration::from_secs(2));
        drop(clients);
        drop(listener);
        std::fs::remove_file(path).unwrap();
    }
}
