// Command kps-bulk-server is a test-only KPS server for the e2e test bed. It
// answers the request/response shape the Nox KPS transport uses (a small
// request, the client half-closes, then a large response) without an echo,
// so that large responses can be measured on their own.
//
// Per stream: the client writes "<size> <seed>\n" and closes its write half;
// the server writes <size> bytes where byte i is (31*i + seed) mod 256, then
// closes its write half. A malformed request or a size above -max-bytes
// resets the stream.
//
// Built inside a checkout of ethereum/kps libs/go by scripts/build-kps-servers.sh.
package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"syscall"

	kps "github.com/ethereum/kps/libs/go"
)

// maxRequestBytes bounds the request line ("<size> <seed>\n").
const maxRequestBytes = 64

// chunkBytes is the size of each write; the KPS stream applies flow control.
const chunkBytes = 64 * 1024

func main() {
	listenFlag := flag.String("listen", ":0", "host:port to bind UDP socket")
	keyFlag := flag.String("key", "kps.key", "path to persistent server key (created if absent)")
	ipFlag := flag.String("ip", "", "ip to advertise in printed address (default: auto)")
	maxFlag := flag.Int64("max-bytes", 64<<20, "largest response size a client may request")
	flag.Parse()

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	listener, err := kps.Listen(ctx, *listenFlag, kps.Options{KeyFile: *keyFlag})
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	defer listener.Close()

	go func() {
		for {
			conn, err := listener.Accept(ctx)
			if err != nil {
				return
			}
			go handleConn(ctx, conn, *maxFlag)
		}
	}()

	fmt.Printf("listening; dial with kps.dial(\"%s\")\n", listener.Address(*ipFlag))

	<-ctx.Done()
}

func handleConn(ctx context.Context, conn kps.Conn, maxBytes int64) {
	for {
		s, err := conn.AcceptStream(ctx)
		if err != nil {
			return
		}
		go serveStream(s, maxBytes)
	}
}

func serveStream(s kps.Stream, maxBytes int64) {
	defer s.Close()
	request, err := io.ReadAll(io.LimitReader(s, maxRequestBytes+1))
	if err != nil || len(request) > maxRequestBytes {
		log.Printf("[bulk] bad request: %d bytes, err %v", len(request), err)
		return
	}
	var size int64
	var seed int
	if _, err := fmt.Sscanf(string(request), "%d %d\n", &size, &seed); err != nil || size < 0 || size > maxBytes {
		log.Printf("[bulk] bad request %q: %v", request, err)
		return
	}
	w := bufio.NewWriterSize(s, chunkBytes)
	for i := int64(0); i < size; i++ {
		if err := w.WriteByte(byte((31*i + int64(seed)) & 0xff)); err != nil {
			log.Printf("[bulk] write at %d of %d: %v", i, size, err)
			return
		}
	}
	if err := w.Flush(); err != nil {
		log.Printf("[bulk] flush: %v", err)
		return
	}
	_ = s.CloseWrite()
}
