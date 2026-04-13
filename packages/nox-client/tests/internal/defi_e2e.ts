/**
 * DeFi E2E Integration Test — Full Alice/Bob/Charlie Flow via NOX Mixnet
 *
 * Tests the complete privacy DeFi pipeline:
 * 1. Deploy DarkPool contracts to Anvil
 * 2. Spin up 5-node NOX mesh (entry → mix → exit)
 * 3. Alice deposits (direct — needs msg.sender for ERC20 approval)
 * 4. Alice transfers to Bob (via mixnet — exit node submits tx)
 * 5. Bob withdraws (via mixnet)
 * 6. Verify all on-chain state
 *
 * Requires: Anvil on :8545, nox_mesh_server with RPC handler
 *
 * Usage:
 *   MESH_INFO_PATH=/tmp/nox_mesh/mesh_info.json npx tsx tests/defi_e2e.ts
 */

import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import NOX SDK
import { NoxClient } from "../../src/client.js";

// Import darkpool-v2 wallet SDK and prover via absolute paths
const DARKPOOL_ROOT = path.resolve(__dirname, "../../../../darkpool-v2");
const CONTRACTS_ROOT = path.join(DARKPOOL_ROOT, "packages/evm-contracts");

// Dynamic imports — tsx handles ESM/CJS interop
const walletsMod = await import(
  pathToFileURL(path.join(DARKPOOL_ROOT, "packages/wallets/dist/index.cjs")).href
);
const proverMod = await import(
  pathToFileURL(path.join(DARKPOOL_ROOT, "packages/prover/dist/index.cjs")).href
);

const {
  DarkAccount,
  toFr,
  addressToFr,
  encryptNoteDeposit,
  deriveSharedSecret,
  KeyRepository,
  UtxoRepository,
  ScanEngine,
  Poseidon,
  LeanIMT,
  generateDLEQProof,
  recipientDecrypt3Party,
  deriveNullifierPathB,
} = walletsMod;

const {
  proveDeposit,
  proveTransfer,
  proveWithdraw,
  unpackCiphertext,
  ensureBBInitialized,
} = proverMod;

// BJJ curve imports
const bjjMod = await import(
  pathToFileURL(
    path.join(DARKPOOL_ROOT, "node_modules/.pnpm/@zk-kit+baby-jubjub@1.0.3/node_modules/@zk-kit/baby-jubjub/dist/index.js"),
  ).href
);
const { Base8, mulPointEscalar } = bjjMod;

// --------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------

// Will be set from deployment secrets or fallback to hardcoded
let COMPLIANCE_SK = 987654321n;
let COMPLIANCE_PK = mulPointEscalar(Base8, COMPLIANCE_SK);
const BJJ_SUBGROUP_ORDER =
  2736030358979909402780800718157159386076813972158567259200215660948447373041n;

const MESH_INFO_PATH =
  process.env.MESH_INFO_PATH || "/tmp/nox_mesh/mesh_info.json";
const ANVIL_RPC = process.env.ANVIL_RPC || "http://127.0.0.1:8545";

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${msg}`);
}

// --------------------------------------------------------------------------
// Contract Deployment (raw ethers.js — no hardhat needed)
// --------------------------------------------------------------------------

function loadArtifact(contractPath: string): { abi: any[]; bytecode: string } {
  const jsonPath = path.join(
    CONTRACTS_ROOT,
    "artifacts/contracts",
    contractPath,
  );
  const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  return { abi: data.abi, bytecode: data.bytecode };
}

async function deployContract(
  signer: ethers.Signer,
  artifact: { abi: any[]; bytecode: string },
  args: any[] = [],
  libraries?: Record<string, string>,
): Promise<ethers.Contract> {
  let bytecode = artifact.bytecode;

  // Link libraries if needed
  if (libraries) {
    for (const [name, addr] of Object.entries(libraries)) {
      // Hardhat uses __$<hash>$__ placeholders for unlinked libraries
      const placeholder = new RegExp(`__\\$[a-f0-9]{34}\\$__`, "g");
      bytecode = bytecode.replace(placeholder, addr.slice(2).toLowerCase().padEnd(40, "0").slice(0, 40));
    }
  }

  const factory = new ethers.ContractFactory(artifact.abi, bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

// Wrap a wallet with NonceManager for sequential nonce tracking
function withNonceManager(wallet: ethers.Wallet): ethers.Signer {
  return new ethers.NonceManager(wallet);
}

interface DeployedContracts {
  darkPool: ethers.Contract;
  token: ethers.Contract;
  rewardPool: ethers.Contract;
  poseidon2: ethers.Contract;
}

async function deployAll(deployer: ethers.Signer): Promise<DeployedContracts> {
  log("Deploying Poseidon2 library...");
  const poseidon2 = await deployContract(
    deployer,
    loadArtifact("Poseidon/Poseidon2.sol/Poseidon2.json"),
  );
  const poseidon2Addr = await poseidon2.getAddress();
  log(`  Poseidon2: ${poseidon2Addr}`);

  log("Deploying 7 verifiers...");
  const verifierNames = [
    "DepositVerifier",
    "WithdrawVerifier",
    "TransferVerifier",
    "JoinVerifier",
    "SplitVerifier",
    "PublicClaimVerifier",
    "GasPaymentVerifier",
  ];
  const verifiers: string[] = [];
  for (const name of verifierNames) {
    const v = await deployContract(
      deployer,
      loadArtifact(`verifiers/${name}.sol/HonkVerifier.json`),
    );
    verifiers.push(await v.getAddress());
  }
  log(`  All 7 verifiers deployed`);

  log("Deploying NoxRewardPool...");
  const rpArtifact = loadArtifact("nox/NoxRewardPool.sol/NoxRewardPool.json");
  const rewardPool = await deployContract(deployer, rpArtifact, [await deployer.getAddress()]);
  log(`  RewardPool: ${await rewardPool.getAddress()}`);

  log("Deploying MockERC20...");
  const token = await deployContract(
    deployer,
    loadArtifact("mocks/MockERC20.sol/MockERC20.json"),
    ["TestToken", "TKN", 18],
  );
  const tokenAddr = await token.getAddress();
  log(`  Token: ${tokenAddr}`);

  // Whitelist token in reward pool
  await (await rewardPool.setAssetStatus(tokenAddr, true)).wait();

  log("Deploying DarkPool...");
  const darkPool = await deployContract(
    deployer,
    loadArtifact("DarkPool.sol/DarkPool.json"),
    [
      ...verifiers,
      await rewardPool.getAddress(),
      COMPLIANCE_PK[0],
      COMPLIANCE_PK[1],
      await deployer.getAddress(),
    ],
    { Poseidon2: poseidon2Addr },
  );
  log(`  DarkPool: ${await darkPool.getAddress()}`);

  return { darkPool, token, rewardPool, poseidon2 };
}

// --------------------------------------------------------------------------
// Wallet Wrapper (adapted from TestWallet but standalone)
// --------------------------------------------------------------------------

interface WalletNote {
  note: any;
  commitment: any;
  leafIndex: number;
  nullifier: any;
  spendingSecret: any;
  isTransfer: boolean;
  derivationIndex: number;
  spent: boolean;
}

class SimpleWallet {
  account: any;
  keyRepo: any;
  utxoRepo: any;
  tree: any;
  signer: ethers.Wallet;
  darkPool: ethers.Contract;
  token: ethers.Contract;

  constructor(
    signer: ethers.Wallet,
    darkPool: ethers.Contract,
    token: ethers.Contract,
  ) {
    this.signer = signer;
    this.darkPool = darkPool;
    this.token = token;
  }

  static async create(
    signer: ethers.Wallet,
    darkPool: ethers.Contract,
    token: ethers.Contract,
  ): Promise<SimpleWallet> {
    const wallet = new SimpleWallet(signer, darkPool, token);
    const signature = await signer.signMessage("Xythum Test Login");
    wallet.account = await DarkAccount.fromSignature(signature);
    wallet.tree = new LeanIMT(32);
    wallet.keyRepo = new KeyRepository(wallet.account, COMPLIANCE_PK);
    wallet.utxoRepo = new UtxoRepository();
    return wallet;
  }

  async syncTree(commitment: any) {
    await this.tree.insert(commitment);
  }

  getBalance(): bigint {
    return this.utxoRepo.getBalance();
  }

  getUnspentNotes(): WalletNote[] {
    return this.utxoRepo.getUnspentNotes();
  }

  // ---- Deposit (DIRECT — needs msg.sender for ERC20 approval) ----
  async deposit(amount: bigint) {
    const { sk: ephemeralSk, nonce } = await this.keyRepo.nextEphemeralParams();
    const skView = await this.account.getViewKey();
    const tokenAddr = await this.token.getAddress();
    const assetFr = addressToFr(tokenAddr);

    const note = {
      value: toFr(amount),
      asset_id: assetFr,
      secret: toFr(BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"))),
      nullifier: toFr(BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"))),
      timelock: toFr(0n),
      hashlock: toFr(0n),
    };

    await encryptNoteDeposit(skView, nonce, note, COMPLIANCE_PK);

    const inputs = {
      notePlaintext: note,
      ephemeralSk,
      compliancePk: COMPLIANCE_PK,
    };

    const proof = await proveDeposit(inputs);
    const darkPoolAddr = await this.darkPool.getAddress();

    // Approve + deposit (direct TX — needs msg.sender)
    // Use explicit nonces to avoid ethers caching issues
    let txNonce = await this.signer.getNonce();
    await (
      await this.token.connect(this.signer).approve(darkPoolAddr, amount, { nonce: txNonce++ })
    ).wait();
    const tx = await this.darkPool
      .connect(this.signer)
      .deposit(proof.proof, proof.publicInputs, { nonce: txNonce });
    const receipt = await tx.wait();

    // Reconstruct commitment
    const pub = proof.publicInputs.map((s: string) => toFr(s));
    const packedCt = pub.slice(6, 13);
    const commitment = await Poseidon.hash(packedCt);

    // Add note to our UTXO store
    const skViewFr = await this.account.getViewKey();
    const ss = await deriveSharedSecret(ephemeralSk, COMPLIANCE_PK);
    const leafIndex = this.tree.nextLeafIndex;
    await this.tree.insert(commitment);

    await this.utxoRepo.addNote({
      note,
      commitment,
      leafIndex,
      nullifier: await walletsMod.deriveNullifierPathA(note.nullifier),
      spendingSecret: ephemeralSk,
      isTransfer: false,
      derivationIndex: 0,
      spent: false,
    });

    return { commitment, receipt, proof };
  }

  // ---- Transfer (builds calldata, returns it for mixnet submission) ----
  async buildTransferCalldata(
    amount: bigint,
    recipientB: any,
    recipientP: any,
    recipientProof: any,
  ): Promise<{ calldata: string; memoCommitment: any; changeCommitment: any; publicInputs: string[] }> {
    const tokenAddr = await this.token.getAddress();
    const targetAssetFr = addressToFr(tokenAddr);

    const notes = this.utxoRepo.getUnspentNotes();
    const assetNotes = notes.filter((n: any) =>
      n.note.asset_id.equals(targetAssetFr),
    );
    const inputData = assetNotes.find(
      (n: any) => n.note.value.toBigInt() >= amount,
    );
    if (!inputData)
      throw new Error(
        `Insufficient funds: need ${amount}, have ${assetNotes.map((n: any) => n.note.value.toBigInt())}`,
      );

    const oldSharedSecret = inputData.isTransfer
      ? inputData.spendingSecret
      : await deriveSharedSecret(inputData.spendingSecret, COMPLIANCE_PK);

    const treePath = this.tree.getMerklePath(inputData.leafIndex);
    const root = this.tree.getRoot();
    const changeValue = inputData.note.value.toBigInt() - amount;

    const memoNote = {
      asset_id: inputData.note.asset_id,
      value: toFr(amount),
      secret: toFr(0),
      nullifier: toFr(0),
      timelock: toFr(0),
      hashlock: toFr(0),
    };
    const memoEphSk = toFr(
      BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")) %
        BJJ_SUBGROUP_ORDER,
    );

    const changeNote = {
      asset_id: inputData.note.asset_id,
      value: toFr(changeValue),
      secret: toFr(BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"))),
      nullifier: toFr(BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"))),
      timelock: toFr(0),
      hashlock: toFr(0),
    };
    const { sk: changeEphSk } = await this.keyRepo.nextEphemeralParams();

    const inputs = {
      merkleRoot: root,
      currentTimestamp: Math.floor(Date.now() / 1000),
      compliancePk: COMPLIANCE_PK,
      recipientB,
      recipientP,
      recipientProof,
      oldNote: inputData.note,
      oldSharedSecret,
      oldNoteIndex: inputData.leafIndex,
      oldNotePath: treePath,
      hashlockPreimage: toFr(0),
      memoNote,
      memoEphemeralSk: memoEphSk,
      changeNote,
      changeEphemeralSk: changeEphSk,
    };

    log(`    DEBUG: oldNoteIndex=${inputData.leafIndex}, treePath len=${treePath?.length}, root type=${typeof root}`);
    const proof = await proveTransfer(inputs);

    // Encode calldata for DarkPool.privateTransfer(bytes, bytes32[])
    const iface = this.darkPool.interface;
    const calldata = iface.encodeFunctionData("privateTransfer", [
      proof.proof,
      proof.publicInputs,
    ]);

    const pub = proof.publicInputs.map((s: string) => toFr(s));
    const memoCommitment = await Poseidon.hash(pub.slice(11, 18));
    const changeCommitment = await Poseidon.hash(pub.slice(24, 31));

    // Mark input as spent
    this.utxoRepo.markSpent(inputData.nullifier.toString());

    // Add change note to our UTXO store
    const changeSs = await deriveSharedSecret(changeEphSk, COMPLIANCE_PK);
    await this.utxoRepo.addNote({
      note: changeNote,
      commitment: changeCommitment,
      leafIndex: this.tree.nextLeafIndex + 1, // Will be updated after on-chain confirmation
      nullifier: await walletsMod.deriveNullifierPathA(changeNote.nullifier),
      spendingSecret: changeEphSk,
      isTransfer: false,
      derivationIndex: 0,
      spent: false,
    });

    return { calldata, memoCommitment, changeCommitment, publicInputs: proof.publicInputs };
  }

  // ---- Receive Transfer (decrypt memo from publicInputs) ----
  async receiveTransfer(
    publicInputs: string[],
    leafIndex: number,
    recipientSk: bigint,
  ) {
    const frInputs = publicInputs.map((s: string) => toFr(s));
    const packedCt = frInputs.slice(11, 18);
    const intBobX = frInputs[18];
    const intBobY = frInputs[19];

    const ct = unpackCiphertext(packedCt);
    const intBobPoint = [intBobX.toBigInt(), intBobY.toBigInt()];
    const { note, sharedSecret } = await recipientDecrypt3Party(
      recipientSk,
      intBobPoint,
      ct,
    );
    const commitment = await Poseidon.hash(packedCt);

    await this.utxoRepo.addNote({
      note,
      commitment,
      leafIndex,
      nullifier: await deriveNullifierPathB(sharedSecret, commitment, leafIndex),
      spendingSecret: sharedSecret,
      isTransfer: true,
      derivationIndex: 0,
      spent: false,
    });
  }

  // ---- Withdraw (builds calldata for mixnet submission) ----
  async buildWithdrawCalldata(
    amount: bigint,
    recipient?: string,
  ): Promise<{ calldata: string; publicInputs: string[] }> {
    const tokenAddr = await this.token.getAddress();
    const targetAssetFr = addressToFr(tokenAddr);
    const targetRecipient = recipient || this.signer.address;

    const notes = this.utxoRepo.getUnspentNotes();
    const assetNotes = notes.filter((n: any) =>
      n.note.asset_id.equals(targetAssetFr),
    );
    const inputData = assetNotes.find(
      (n: any) => n.note.value.toBigInt() >= amount,
    );
    if (!inputData)
      throw new Error(
        `Insufficient funds: need ${amount}, have ${assetNotes.length} notes`,
      );

    const oldSharedSecret = inputData.isTransfer
      ? inputData.spendingSecret
      : await deriveSharedSecret(inputData.spendingSecret, COMPLIANCE_PK);

    const changeValue = inputData.note.value.toBigInt() - amount;
    const changeNote = {
      ...inputData.note,
      value: toFr(changeValue),
      secret: toFr(BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"))),
      nullifier: toFr(BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"))),
      timelock: toFr(0),
      hashlock: toFr(0),
    };
    const { sk: changeEphSk } = await this.keyRepo.nextEphemeralParams();

    const inputs = {
      withdrawValue: toFr(amount),
      recipient: addressToFr(targetRecipient),
      merkleRoot: this.tree.getRoot(),
      currentTimestamp: Math.floor(Date.now() / 1000),
      intentHash: toFr(0),
      compliancePk: COMPLIANCE_PK,
      oldNote: inputData.note,
      oldSharedSecret,
      oldNoteIndex: inputData.leafIndex,
      oldNotePath: this.tree.getMerklePath(inputData.leafIndex),
      hashlockPreimage: toFr(0),
      changeNote,
      changeEphemeralSk: changeEphSk,
    };

    const proof = await proveWithdraw(inputs);

    const iface = this.darkPool.interface;
    const calldata = iface.encodeFunctionData("withdraw", [
      proof.proof,
      proof.publicInputs,
    ]);

    // Mark input as spent
    this.utxoRepo.markSpent(inputData.nullifier.toString());

    return { calldata, publicInputs: proof.publicInputs };
  }
}

// --------------------------------------------------------------------------
// Main Test Flow
// --------------------------------------------------------------------------

async function main() {
  log("=== DeFi E2E Integration Test via NOX Mixnet ===");
  log("");

  // 1. Connect to Anvil
  const provider = new ethers.JsonRpcProvider(ANVIL_RPC);
  const accounts = await provider.listAccounts();
  if (accounts.length < 5) throw new Error("Need at least 5 Anvil accounts");

  // Use Anvil's pre-funded accounts
  const deployer = new ethers.Wallet(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    provider,
  ); // Account 0
  const alice = new ethers.Wallet(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    provider,
  ); // Account 1
  const bob = new ethers.Wallet(
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    provider,
  ); // Account 2

  log(`Deployer: ${deployer.address}`);
  log(`Alice:    ${alice.address}`);
  log(`Bob:      ${bob.address}`);

  // 2. Initialize BB prover (one-time, heavy)
  log("Initializing Barretenberg prover...");
  await ensureBBInitialized();
  log("  BB ready");

  // 3. Load pre-deployed contracts (deployed via `npx hardhat run scripts/deploy.ts --network localhost`)
  log("");
  log("--- Phase 1: Load Deployed Contracts ---");
  const DEPLOY_FILE = path.join(CONTRACTS_ROOT, "deployments/localhost-latest.json");
  if (!fs.existsSync(DEPLOY_FILE)) {
    throw new Error(
      `No deployment found at ${DEPLOY_FILE}. Run: cd darkpool-v2/packages/evm-contracts && NODE_OPTIONS="--import tsx" npx hardhat run scripts/deploy.ts --network localhost`,
    );
  }
  const deployment = JSON.parse(fs.readFileSync(DEPLOY_FILE, "utf-8"));
  const darkPoolAddr = deployment.contracts.darkPool;
  const tokenAddr = deployment.contracts.stakingToken;

  // Load compliance key from deployment secrets
  const secretsFiles = fs.readdirSync(path.join(CONTRACTS_ROOT, "deployments"))
    .filter((f: string) => f.includes("localhost") && f.endsWith(".secrets.json"))
    .sort()
    .reverse();
  if (secretsFiles.length > 0) {
    const secrets = JSON.parse(
      fs.readFileSync(path.join(CONTRACTS_ROOT, "deployments", secretsFiles[0]), "utf-8"),
    );
    COMPLIANCE_SK = BigInt(secrets.complianceSecretKey);
    COMPLIANCE_PK = mulPointEscalar(Base8, COMPLIANCE_SK);
    log(`  Compliance PK loaded from deployment secrets`);
  }

  const darkPoolAbi = loadArtifact("DarkPool.sol/DarkPool.json").abi;
  const tokenAbi = loadArtifact("mocks/MockERC20.sol/MockERC20.json").abi;
  const darkPool = new ethers.Contract(darkPoolAddr, darkPoolAbi, deployer);
  const token = new ethers.Contract(tokenAddr, tokenAbi, deployer);

  log(`  DarkPool: ${darkPoolAddr}`);
  log(`  Token:    ${tokenAddr}`);

  // Mint tokens to Alice and Bob
  // Use Alice/Bob as minters (separate nonce from deployer, avoids cache issues)
  // First, give deployer's MINTER_ROLE to Alice... or just use deployer with explicit nonces
  const INITIAL = ethers.parseEther("10000");
  let currentNonce = await provider.getTransactionCount(deployer.address);
  log(`  Deployer nonce: ${currentNonce}`);
  const mintTx1 = await token.connect(deployer).mint(alice.address, INITIAL, { nonce: currentNonce });
  await mintTx1.wait();
  const mintTx2 = await token.connect(deployer).mint(bob.address, INITIAL, { nonce: currentNonce + 1 });
  await mintTx2.wait();
  log(`  Minted ${ethers.formatEther(INITIAL)} TKN to Alice and Bob`);

  // 4. Connect NoxClient (if mesh is running)
  let noxClient: NoxClient | null = null;
  let meshInfo: any = null;

  if (fs.existsSync(MESH_INFO_PATH)) {
    meshInfo = JSON.parse(fs.readFileSync(MESH_INFO_PATH, "utf-8"));
    log("");
    log("--- Phase 2: Connect to NOX Mesh ---");
    log(`  Mesh: ${meshInfo.node_count} nodes, entry: ${meshInfo.entry_url}`);

    // Construct seed URL from mesh_info (metrics port of first node serves topology)
    const seedUrl = meshInfo.seed_url || `http://127.0.0.1:${meshInfo.nodes[0].metrics_port}`;
    log(`  Seed URL: ${seedUrl}`);

    noxClient = await NoxClient.connect({
      seeds: [seedUrl],
      dangerouslySkipFingerprintCheck: true,
    });
    log("  NoxClient connected");
  } else {
    log("");
    log("--- Phase 2: No mesh running (direct mode) ---");
    log("  Set MESH_INFO_PATH to test via mixnet");
  }

  // 5. Create wallets
  log("");
  log("--- Phase 3: Bootstrap Wallets ---");
  const aliceWallet = await SimpleWallet.create(alice, darkPool, token);
  const bobWallet = await SimpleWallet.create(bob, darkPool, token);
  log("  Alice and Bob wallets initialized");

  // 6. Alice deposits (DIRECT — needs msg.sender for approve)
  log("");
  log("--- Phase 4: Alice Deposits 100 TKN (direct) ---");
  const DEPOSIT_AMOUNT = ethers.parseEther("100");
  const aliceBalBefore = await token.balanceOf(alice.address);
  const bobBalBefore = await token.balanceOf(bob.address);
  log(`  Alice starting on-chain: ${ethers.formatEther(aliceBalBefore)} TKN`);
  const depResult = await aliceWallet.deposit(DEPOSIT_AMOUNT);
  log(`  Deposited. Commitment: ${depResult.commitment.toString().slice(0, 20)}...`);

  // Bob syncs tree
  await bobWallet.syncTree(depResult.commitment);

  // Verify
  const aliceBal = aliceWallet.getBalance();
  assert(aliceBal === DEPOSIT_AMOUNT, `Alice balance: ${aliceBal} != ${DEPOSIT_AMOUNT}`);
  const aliceTokenBal = await token.balanceOf(alice.address);
  assert(
    aliceTokenBal === aliceBalBefore - DEPOSIT_AMOUNT,
    `Alice token balance wrong: ${aliceTokenBal} (expected ${aliceBalBefore - DEPOSIT_AMOUNT})`,
  );
  log(`  Alice balance: ${ethers.formatEther(aliceBal)} TKN (private)`);
  log(`  Alice on-chain: ${ethers.formatEther(aliceTokenBal)} TKN`);

  // 7. Alice transfers 50 TKN to Bob
  log("");
  log("--- Phase 5: Alice Transfers 50 TKN to Bob ---");
  const TRANSFER_AMOUNT = ethers.parseEther("50");

  // Bob prepares his receiving address
  await bobWallet.keyRepo.advanceIncomingKeys(1);
  const bobIvk = await bobWallet.account.getIncomingViewingKey(0n);
  const bobAddr = await generateDLEQProof(bobIvk.toBigInt(), COMPLIANCE_PK);

  // Alice builds transfer proof + calldata
  log("  Building transfer proof...");
  const transferResult = await aliceWallet.buildTransferCalldata(
    TRANSFER_AMOUNT,
    bobAddr.B,
    bobAddr.P,
    bobAddr.pi,
  );
  log(`  Proof built. Calldata: ${transferResult.calldata.length} bytes`);

  // Submit via mixnet or direct
  if (noxClient) {
    log("  Signing + submitting via NOX mixnet (eth_sendRawTransaction)...");
    // Sign a full transaction with deployer (acts as relayer in real system)
    const txNonceTransfer = await provider.getTransactionCount(deployer.address);
    const signedTx = await deployer.signTransaction({
      to: darkPoolAddr,
      data: transferResult.calldata,
      gasLimit: 5_000_000n,
      nonce: txNonceTransfer,
      chainId: 31337n,
      gasPrice: (await provider.getFeeData()).gasPrice || 1000000000n,
    });
    // Send signed tx through mixnet via RPC
    const txHash = await noxClient.rpcCall("eth_sendRawTransaction", [signedTx]);
    log(`  Mixnet TX hash: ${txHash}`);
    // Wait for confirmation
    const receipt = await provider.waitForTransaction(String(txHash), 1, 30000);
    assert(receipt !== null && receipt.status === 1, `Transfer TX failed: ${JSON.stringify(receipt)}`);
    log(`  TX confirmed in block ${receipt!.blockNumber}`);
  } else {
    log("  Submitting directly (no mesh)...");
    const tx = await deployer.sendTransaction({
      to: darkPoolAddr,
      data: transferResult.calldata,
      gasLimit: 5_000_000n,
    });
    await tx.wait();
    log(`  TX confirmed: ${tx.hash}`);
  }

  // Sync trees — 2 new leaves (memo + change)
  await aliceWallet.syncTree(transferResult.memoCommitment);
  await aliceWallet.syncTree(transferResult.changeCommitment);
  await bobWallet.syncTree(transferResult.memoCommitment);
  await bobWallet.syncTree(transferResult.changeCommitment);

  // Bob decrypts memo
  const memoLeafIndex = bobWallet.tree.nextLeafIndex - 2; // memo was inserted before change
  await bobWallet.receiveTransfer(
    transferResult.publicInputs,
    memoLeafIndex,
    bobIvk.toBigInt(),
  );

  const bobBal = bobWallet.getBalance();
  const aliceBal2 = aliceWallet.getBalance();
  assert(bobBal === TRANSFER_AMOUNT, `Bob balance: ${bobBal} != ${TRANSFER_AMOUNT}`);
  assert(
    aliceBal2 === DEPOSIT_AMOUNT - TRANSFER_AMOUNT,
    `Alice balance: ${aliceBal2} != ${DEPOSIT_AMOUNT - TRANSFER_AMOUNT}`,
  );
  log(`  Bob balance: ${ethers.formatEther(bobBal)} TKN (private)`);
  log(`  Alice balance: ${ethers.formatEther(aliceBal2)} TKN (private)`);

  // 8. Bob withdraws 50 TKN
  log("");
  log("--- Phase 6: Bob Withdraws 50 TKN ---");
  const WITHDRAW_AMOUNT = ethers.parseEther("50");

  log("  Building withdraw proof...");
  const withdrawResult = await bobWallet.buildWithdrawCalldata(
    WITHDRAW_AMOUNT,
    bob.address,
  );
  log(`  Proof built. Calldata: ${withdrawResult.calldata.length} bytes`);

  // Submit via mixnet or direct
  if (noxClient) {
    log("  Signing + submitting via NOX mixnet (eth_sendRawTransaction)...");
    const txNonceWithdraw = await provider.getTransactionCount(deployer.address);
    const signedWithdrawTx = await deployer.signTransaction({
      to: darkPoolAddr,
      data: withdrawResult.calldata,
      gasLimit: 5_000_000n,
      nonce: txNonceWithdraw,
      chainId: 31337n,
      gasPrice: (await provider.getFeeData()).gasPrice || 1000000000n,
    });
    const wdTxHash = await noxClient.rpcCall("eth_sendRawTransaction", [signedWithdrawTx]);
    log(`  Mixnet TX hash: ${wdTxHash}`);
    const wdReceipt = await provider.waitForTransaction(String(wdTxHash), 1, 30000);
    assert(wdReceipt !== null && wdReceipt.status === 1, `Withdraw TX failed`);
    log(`  TX confirmed in block ${wdReceipt!.blockNumber}`);
  } else {
    log("  Submitting directly (no mesh)...");
    const tx = await deployer.sendTransaction({
      to: darkPoolAddr,
      data: withdrawResult.calldata,
      gasLimit: 5_000_000n,
    });
    await tx.wait();
    log(`  TX confirmed: ${tx.hash}`);
  }

  // Verify Bob's on-chain balance increased
  const bobTokenBal = await token.balanceOf(bob.address);
  assert(
    bobTokenBal === bobBalBefore + WITHDRAW_AMOUNT,
    `Bob token balance: ${bobTokenBal} != ${bobBalBefore + WITHDRAW_AMOUNT}`,
  );
  log(`  Bob on-chain: ${ethers.formatEther(bobTokenBal)} TKN`);

  // Final summary
  log("");
  log("========================================");
  log("DeFi E2E Integration Test — ALL PASSED");
  log("========================================");
  log(`  Deposit:  Alice deposited ${ethers.formatEther(DEPOSIT_AMOUNT)} TKN`);
  log(`  Transfer: Alice sent ${ethers.formatEther(TRANSFER_AMOUNT)} TKN to Bob${noxClient ? " (via mixnet)" : " (direct)"}`);
  log(`  Withdraw: Bob withdrew ${ethers.formatEther(WITHDRAW_AMOUNT)} TKN${noxClient ? " (via mixnet)" : " (direct)"}`);
  log(`  On-chain verified: Alice ${ethers.formatEther(await token.balanceOf(alice.address))}, Bob ${ethers.formatEther(bobTokenBal)} TKN`);
  if (noxClient) {
    noxClient.disconnect();
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    log(`ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
