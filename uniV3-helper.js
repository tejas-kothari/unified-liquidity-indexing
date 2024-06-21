import { ethers } from "ethers";
import { computePoolAddress } from "@uniswap/v3-sdk";
import IUniswapV3PoolABI from "@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json" assert { type: "json" };
import { getProvider } from "./chain-helper.js";

const getPoolString = (chain, tokenA, tokenB, fee) =>
  `[${chain.key} - UniV3 ${tokenA.symbol} ${tokenB.symbol} ${
    (fee / 10 ** 6) * 100 * 100
  }bps]`;

const getPool = async (chain, tokenA, tokenB, fee, provider) => {
  const poolId = computePoolAddress({
    factoryAddress: chain.uniV3FactoryAddress,
    tokenA: tokenA,
    tokenB: tokenB,
    fee: fee,
  });

  const poolContract = new ethers.Contract(
    poolId,
    IUniswapV3PoolABI.abi,
    provider
  );

  const tickSpacing = await poolContract.tickSpacing().then((v) => Number(v));

  console.log(
    getPoolString(chain, tokenA, tokenB, fee).concat(
      `[Init] ${tickSpacing}ts | ${poolContract.target}`
    )
  );

  return [poolContract, tickSpacing];
};

function tickToWord(tick, tickSpacing) {
  let compressed = Math.floor(tick / tickSpacing);
  if (tick < 0 && tick % tickSpacing !== 0) {
    compressed -= 1;
  }
  return compressed >> 8;
}

const getInitializedTicks = async (poolContract, tickSpacing) => {
  const minWord = tickToWord(-887272, tickSpacing);
  const maxWord = tickToWord(887272, tickSpacing);

  let calls = [];
  let wordPosIndices = [];
  for (let i = minWord; i <= maxWord; i++) {
    wordPosIndices.push(i);
    calls.push(poolContract.tickBitmap(i));
  }
  const results = await Promise.all(calls).then((v) =>
    v.map((k) => BigInt(k.toString()))
  );

  const tickIndices = [];
  for (let j = 0; j < wordPosIndices.length; j++) {
    const ind = wordPosIndices[j];
    const bitmap = results[j];

    if (bitmap !== 0n) {
      for (let i = 0; i < 256; i++) {
        const bit = 1n;
        const initialized = (bitmap & (bit << BigInt(i))) !== 0n;
        if (initialized) {
          const tickIndex = (ind * 256 + i) * tickSpacing;
          tickIndices.push(tickIndex);
        }
      }
    }
  }

  return tickIndices;
};

const getTickInfo = async (poolContract, tickIndices) => {
  const calls = [];
  for (const index of tickIndices) {
    calls.push(poolContract.ticks(index));
  }
  return Promise.all(calls);
};

const updateTick = (ticks, tick, liquidityDelta, upper) => {
  const liquidityBefore = ticks?.[tick]?.[0] ?? BigInt(0);
  const liquidityAfter = liquidityBefore + liquidityDelta;
  const flipped = (liquidityAfter == 0) != (liquidityBefore == 0);
  ticks[tick] = {
    ...ticks?.[tick],
    liquidityGross: liquidityAfter,
    liquidityNet: upper
      ? (ticks?.[tick]?.[1] ?? BigInt(0)) - liquidityDelta
      : (ticks?.[tick]?.[1] ?? BigInt(0)) + liquidityDelta,
  };
};

const printEvent = (chain, tokenA, tokenB, fee, eventParams, eventType) => {
  if (eventType === "Swap") {
    console.log(`${getPoolString(chain, tokenA, tokenB, fee)}[Swap]
    sender: ${eventParams[0]}
    recipient: ${eventParams[1]}
    amount0: ${eventParams[2]}
    amount1: ${eventParams[3]}
    sqrtPriceX96: ${eventParams[4]}
    liquidity: ${eventParams[5]}
    tick: ${eventParams[6]}
    block: ${eventParams[7]}
    `);
  } else if (eventType === "Mint") {
    console.log(`${getPoolString(chain, tokenA, tokenB, fee)}[Mint]
    sender: ${eventParams[0]}
    owner: ${eventParams[1]}
    tickLower: ${eventParams[2]}
    tickUpper: ${eventParams[3]}
    amount: ${eventParams[4]}
    amount0: ${eventParams[5]}
    amount1: ${eventParams[6]}
    block: ${eventParams[7]}
    `);
  } else if (eventType === "Burn") {
    console.log(`${getPoolString(chain, tokenA, tokenB, fee)}[Burn]
    owner: ${eventParams[0]}
    tickLower: ${eventParams[1]}
    tickUpper: ${eventParams[2]}
    amount: ${eventParams[3]}
    amount0: ${eventParams[4]}
    amount1: ${eventParams[5]}
    block: ${eventParams[6]}
    `);
  }
};

export const setupIndexing = async (
  redisClient,
  chain,
  tokenA,
  tokenB,
  fee
) => {
  const provider = getProvider(chain.rpc);

  const [poolContract, tickSpacing] = await getPool(
    chain,
    tokenA,
    tokenB,
    fee,
    provider
  );

  const tickIndices = await getInitializedTicks(poolContract, tickSpacing);
  const tickInfos = await getTickInfo(poolContract, tickIndices);

  const [slot0, liquidity] = await Promise.all([
    poolContract.slot0().then((v) => v.toObject()),
    poolContract.liquidity(),
  ]);

  const pool = {
    ticks: {},
    slot0,
    liquidity,
    poolKey: {
      tokenA: tokenA.address,
      tokenB: tokenB.address,
      tickSpacing,
      fee,
      extra: "",
    },
  };
  tickIndices.forEach((v, i) => {
    pool["ticks"][v] = [tickInfos[i].liquidityGross, tickInfos[i].liquidityNet];
  });

  BigInt.prototype["toJSON"] = function () {
    return this.toString();
  };

  poolContract.on(poolContract.filters.Swap, (...eventParams) => {
    try {
      printEvent(chain, tokenA, tokenB, fee, eventParams, "Swap");

      pool.slot0.sqrtPriceX96 = eventParams[4];
      pool.liquidity = eventParams[5];
      pool.slot0.tick = eventParams[6];
    } catch (e) {
      console.log(e);
    }
  });

  poolContract.on(poolContract.filters.Mint, (...eventParams) => {
    try {
      printEvent(chain, tokenA, tokenB, fee, eventParams, "Mint");

      const lowerTick = eventParams[2];
      const upperTick = eventParams[3];
      const amount = eventParams[4];

      if (pool.currentTick >= lowerTick && pool.currentTick < upperTick) {
        pool.liquidity += amount;
      }

      updateTick(pool.ticks, lowerTick, amount, false);
      updateTick(pool.ticks, upperTick, amount, true);
    } catch (e) {
      console.log(e);
    }
  });

  poolContract.on(poolContract.filters.Burn, (...eventParams) => {
    try {
      printEvent(chain, tokenA, tokenB, fee, eventParams, "Burn");

      const lowerTick = eventParams[1];
      const upperTick = eventParams[2];
      const amount = eventParams[3];

      if (pool.currentTick >= lowerTick && pool.currentTick < upperTick) {
        pool.liquidity -= amount;
      }

      updateTick(pool.ticks, lowerTick, -amount, false);
      updateTick(pool.ticks, upperTick, -amount, true);
    } catch (e) {
      console.log(e);
    }
  });
};
