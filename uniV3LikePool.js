import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";
import { getERC20Balance } from "./viem-chain-helper.js";

export class UniV3LikePool {
  constructor(token0, token1, fee, tickSpacing, chain, viemClient) {
    [this.token0, this.token1] =
      token0.address < token1.address ? [token0, token1] : [token1, token0];
    this.fee = fee;
    this.tickSpacing = tickSpacing;
    this.chain = chain;
    this.viemClient = viemClient;
    this.ticks = {};
  }

  static feeToBp = (fee) => (fee / 10 ** 6) * 100 * 100;

  getAddress = () => {
    return this.contract.address;
  };

  tickToWord = (tick) => {
    let compressed = Math.floor(tick / this.tickSpacing);
    if (tick < 0 && tick % this.tickSpacing !== 0) {
      compressed -= 1;
    }
    return compressed >> 8;
  };

  getInitializedTicks = async () => {
    const minWord = this.tickToWord(-887272);
    const maxWord = this.tickToWord(887272);

    const calls = [];
    const wordPosIndices = [];
    for (let i = minWord; i <= maxWord; i++) {
      wordPosIndices.push(i);
      calls.push({
        address: this.contract.address,
        abi: this.contract.abi,
        functionName: "tickBitmap",
        args: [i],
      });
    }

    const results = await this.viemClient.multicall({
      contracts: calls,
      allowFailure: false,
    });

    const tickIndices = [];
    for (let j = 0; j < wordPosIndices.length; j++) {
      const ind = wordPosIndices[j];
      const bitmap = results[j];

      if (bitmap !== 0n) {
        for (let i = 0; i < 256; i++) {
          const bit = 1n;
          const initialized = (bitmap & (bit << BigInt(i))) !== 0n;
          if (initialized) {
            const tickIndex = (ind * 256 + i) * this.tickSpacing;
            tickIndices.push(tickIndex);
          }
        }
      }
    }

    return tickIndices;
  };

  getTickInfo = async (tickIndices) => {
    return this.viemClient.multicall({
      contracts: tickIndices.map((v) => ({
        address: this.contract.address,
        abi: this.contract.abi,
        functionName: "ticks",
        args: [v],
      })),
      allowFailure: false,
    });
  };

  getInitPoolData = async () => {
    if (this.contract === undefined) {
      await this.getPoolContract();
    }

    [
      this.slot0,
      this.liquidity,
      this.token0Bal,
      this.token1Bal,
      this.blockNumber,
      this.tickSpacing,
      this.fee,
    ] = await Promise.all([
      this.contract.read.slot0(),
      this.contract.read.liquidity(),
      getERC20Balance(
        this.contract.address,
        this.token0.address,
        this.viemClient
      ),
      getERC20Balance(
        this.contract.address,
        this.token1.address,
        this.viemClient
      ),
      this.viemClient.getBlockNumber(),
      this.tickSpacing === undefined
        ? this.contract.read.tickSpacing()
        : this.tickSpacing,
      this.fee === undefined ? this.contract.read.fee() : this.fee,
    ]);

    const tickIndices = await this.getInitializedTicks();
    const tickInfos = await this.getTickInfo(tickIndices);
    tickIndices.forEach((v, i) => {
      this.ticks[v] = [tickInfos[i][0], tickInfos[i][1]];
    });

    this.poolId = this.dex
      .concat(":")
      .concat(
        keccak256(
          encodeAbiParameters(
            parseAbiParameters("address, address, uint24, int24"),
            [
              this.token0.address,
              this.token1.address,
              this.fee,
              this.tickSpacing,
            ]
          )
        )
      );

    console.log(this.getPoolString().concat(`[Init] ${this.contract.address}`));
  };

  getPoolString = () =>
    `[${this.chain.key} - ${this.dex} ${this.token0.symbol}/${
      this.token1.symbol
    } ${UniV3LikePool.feeToBp(this.fee)}bp ${this.tickSpacing}ts]`;

  toJSON = () => {
    const obj = {
      blockNumber: this.blockNumber,
      ticks: { ...this.ticks },
      slot0: this.slot0,
      liquidity: this.liquidity,
      reserve: [this.token0Bal, this.token1Bal],
      poolAddress: this.contract.address.toLowerCase(),
      poolKey: {
        base: this.token0.address,
        quote: this.token1.address,
        tickSpacing: this.tickSpacing,
        fee: this.fee,
        extra: "",
      },
    };

    return obj;
  };

  updatePoolDataFromLog = (log) => {
    if (log.eventName === "Swap") {
      this.token0Bal += log.args.amount0;
      this.token1Bal += log.args.amount1;
      this.slot0[0] = log.args.sqrtPriceX96;
      this.slot0[1] = log.args.tick;
      this.liquidity = log.args.liquidity;
    } else if (log.eventName === "Mint") {
      this.token0Bal += log.args.amount0;
      this.token1Bal += log.args.amount1;
      if (
        this.slot0[1] >= log.args.tickLower &&
        this.slot0[1] < log.args.tickUpper
      ) {
        this.liquidity += log.args.amount;
      }
      this.updateTick(log.args.tickLower, log.args.amount, false);
      this.updateTick(log.args.tickUpper, log.args.amount, true);
    } else if (log.eventName === "Burn") {
      this.token0Bal -= log.args.amount0;
      this.token1Bal -= log.args.amount1;
      if (
        this.slot0[1] >= log.args.tickLower &&
        this.slot0[1] < log.args.tickUpper
      ) {
        this.liquidity -= log.args.amount;
      }
      this.updateTick(log.args.tickLower, -log.args.amount, false);
      this.updateTick(log.args.tickUpper, -log.args.amount, true);
    }
    this.blockNumber = log.blockNumber;
  };

  updateTick = (tick, liquidityDelta, isUpper) => {
    const liquidityBefore = this.ticks[tick]?.[0] ?? BigInt(0);
    const liquidityAfter = liquidityBefore + liquidityDelta;
    const liquidityNet = this.ticks[tick]?.[1] ?? BigInt(0);
    this.ticks[tick] = [
      liquidityAfter,
      isUpper ? liquidityNet - liquidityDelta : liquidityNet + liquidityDelta,
    ];
  };
}
