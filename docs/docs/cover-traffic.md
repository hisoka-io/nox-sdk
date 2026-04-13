---
sidebar_position: 6
title: Cover Traffic
---

# Cover Traffic

Even with encrypted packets, an observer watching your connection can learn when you're active. Cover traffic fixes this by sending dummy packets at random intervals  - making real traffic indistinguishable from noise.

## Enable cover traffic

```ts
import { NoxClient, createCoverController } from "@hisoka-io/nox-client";

const client = await NoxClient.connect();
const cover = createCoverController(client);

cover.start();
```

## Configure

```ts
cover.start({
  lambdaP: 1.0,
  maxPaddingBytes: 512,
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `lambdaP` | `number` | `1.0` | Average packets per second. Higher = more cover, more bandwidth. |
| `maxPaddingBytes` | `number` | `512` | Max random padding bytes per dummy packet. |
| `powDifficulty` | `number` | `0` | Proof-of-work difficulty for dummy packets. |

The interval between packets follows an exponential distribution (Poisson process). With `lambdaP: 1.0`, you send ~1 dummy packet per second on average, but the actual timing is random  - which is the point.

## Stop

```ts
cover.stop();
client.disconnect();
```

Always stop cover traffic before disconnecting.

## Bandwidth estimation

Each cover packet is a 32 KB Sphinx packet. The bandwidth cost depends on `lambdaP`:

| `lambdaP` | Packets/min | Bandwidth | Use case |
|-----------|-------------|-----------|----------|
| `0.1` | ~6 | ~190 KB/min | Low-bandwidth mobile or metered connections |
| `0.5` | ~30 | ~960 KB/min | Moderate privacy on a typical connection |
| `1.0` | ~60 | ~1.9 MB/min | Default  - good balance of privacy and cost |
| `5.0` | ~300 | ~9.4 MB/min | High-security  - heavy traffic blending |
| `10.0` | ~600 | ~18.8 MB/min | Maximum anonymity, requires broadband |

These are averages. The Poisson distribution means actual rates fluctuate  - you'll see bursts and gaps, which is what makes the traffic pattern hard to fingerprint.

### Choosing a value

- **Start with the default** (`1.0`). It's enough to mask occasional RPC calls and transactions.
- **Lower it** if you're on a metered connection or mobile data. Even `0.1` provides some cover.
- **Raise it** if you're making frequent transactions and want them to blend into constant noise. Match `lambdaP` roughly to your peak real traffic rate.
- **Don't go overboard**. Cover traffic only protects against traffic analysis  - it doesn't help if your real traffic rate already exceeds `lambdaP`.

## When to use it

**Use it** when you need strong privacy guarantees  - the observer can't tell when you're making real transactions vs. idle.

**Skip it** if bandwidth is constrained or privacy against a global passive adversary isn't your threat model.
