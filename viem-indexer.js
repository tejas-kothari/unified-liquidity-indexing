import "dotenv/config";
import { createClient } from "redis";
import { createPublicClient, decodeEventLog, parseAbi, webSocket } from "viem";
import { chains, getToken } from "./viem-chain-helper.js";
import {
  getInitPoolData,
  getPoolString,
  updatePoolData,
} from "./viem-uniV3-helper.js";

const redisClient = createClient({ url: process.env.DB_URL });
redisClient.on("error", (err) => console.log("Redis Client Error", err));
await redisClient.connect();

let viemClient = createPublicClient({
  transport: webSocket(process.env.RPC),
});
const chainId = await viemClient.getChainId();
const chain = chains.find((v) => v.id === chainId);
viemClient = createPublicClient({
  chain: chain,
  transport: webSocket(process.env.RPC),
});

let fetchedActivePools = [];
let activePools = [];
let lastActivePoolFetchTimeMS = 0;
let poolData = {};
let unwatch = undefined;
let updateRedisQueue = [];

BigInt.prototype["toJSON"] = function () {
  return this.toString();
};

const processLog = (log) => {
  const pool = poolData?.[log.address.toLowerCase()];
  if (pool === undefined) return;

  console.log(
    `${getPoolString(
      chain.key,
      getToken(chainId, pool.poolKey.base).symbol,
      getToken(chainId, pool.poolKey.quote).symbol,
      pool.poolKey.fee
    )}[${log.eventName}]`
  );
  console.log(log);

  updatePoolData(pool, log);

  updateRedisQueue.push(() =>
    redisClient.hSet(
      `pools:${chain.key}`,
      pool.poolAddress,
      JSON.stringify(pool)
    )
  );
};

while (true) {
  const currTimeMS = new Date().getTime();

  if (currTimeMS - lastActivePoolFetchTimeMS > 60_000) {
    lastActivePoolFetchTimeMS = currTimeMS;
    fetchedActivePools = await redisClient
      .hGet(`pools:${chain.key}`, "active-pools")
      .then((v) => JSON.parse(v));
  }

  if (JSON.stringify(activePools) !== JSON.stringify(fetchedActivePools)) {
    activePools = [...fetchedActivePools];

    const initPoolDataFetch = [];
    for (const pool of activePools) {
      initPoolDataFetch.push(
        getInitPoolData(
          chain,
          viemClient,
          getToken(chainId, pool[0]),
          getToken(chainId, pool[1]),
          pool[2]
        ).then((v) => {
          poolData[v.poolAddress] = v;
          return redisClient.hSet(
            `pools:${chain.key}`,
            v.poolAddress,
            JSON.stringify(v)
          );
        })
      );
    }
    await Promise.all(initPoolDataFetch);

    if (unwatch !== undefined) unwatch();

    const abi = parseAbi([
      "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
      "event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
      "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
    ]);

    unwatch = viemClient.watchEvent({
      events: abi,
      onLogs: (logs) =>
        logs.forEach((v) =>
          processLog({
            ...v,
            ...decodeEventLog({ abi: abi, data: v.data, topics: v.topics }),
          })
        ),
    });
  }

  for (const redisUpdate of updateRedisQueue) {
    await redisUpdate();
  }
  updateRedisQueue = [];

  await new Promise((resolve) => setImmediate(resolve));
}
