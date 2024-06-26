import { createClient } from "redis";
import { createPublicClient, decodeEventLog, parseAbi, webSocket } from "viem";
import { chains, getToken } from "./chains.js";
import { UniV3Pool } from "./uniV3Pool.js";
import { VeloV3Pool } from "./veloV3Pool.js";
import commandLineArgs from "command-line-args";

const optionDefinitions = [
  { name: "RPC", type: String },
  { name: "KEYDB", type: String },
  { name: "PUB_CHANNEL", type: String, defaultValue: "indexer_updates" },
];
const { RPC, KEYDB, PUB_CHANNEL } = commandLineArgs(optionDefinitions);

const redisClient = createClient({ url: KEYDB });
const redisPubClient = redisClient.duplicate();
redisClient.on("error", (err) => console.log("Redis Client Error", err));
redisPubClient.on("error", (err) => console.log("Redis Pub Client Error", err));
await Promise.all([redisClient.connect(), redisPubClient.connect()]);

const chainId = await createPublicClient({
  transport: webSocket(RPC),
}).getChainId();
const chain = chains.find((v) => v.id === chainId);
const viemClient = createPublicClient({
  chain: chain,
  transport: webSocket(RPC),
});

let activePoolTopics = [];
let lastActivePoolsFetchTimeMS = 0;
const pools = {};
let unwatch = undefined;
let updateRedisQueue = [];

const getPoolFromTopic = (poolTopic) => {
  const identifers = poolTopic.split(/[:/]/);
  const dex = identifers[0];
  const token0 = getToken(chainId, identifers[1]);
  const token1 = getToken(chainId, identifers[2]);
  const numericalIdentifers = identifers.slice(3);
  let pool;

  if (dex === "UniV3") {
    const fee = Number(
      numericalIdentifers.find((v) => v.includes("bp"))?.replace("bp", "")
    );
    pool = new UniV3Pool(token0, token1, fee, chain, viemClient);
  } else if (dex === "VeloV3") {
    const tickSpacing = Number(
      numericalIdentifers.find((v) => v.includes("ts"))?.replace("ts", "")
    );
    pool = new VeloV3Pool(token0, token1, tickSpacing, chain, viemClient);
  }

  return pool;
};

const processLog = (log) => {
  const pool = pools?.[log.address.toLowerCase()];
  if (pool === undefined) return;

  console.log(`${pool.getPoolString()}[${log.eventName}]`);
  console.log(log);

  pool.updatePoolDataFromLog(log);

  const poolJSON = JSON.stringify(pool, (_, v) =>
    typeof v === "bigint" ? v.toString() : v
  );

  updateRedisQueue.push(() =>
    redisPubClient
      .publish(PUB_CHANNEL, poolJSON)
      .then((v) =>
        redisClient.hSet(`pools:${chain.key}`, pool.poolId, poolJSON)
      )
  );
};

while (true) {
  const currTimeMS = new Date().getTime();

  if (currTimeMS - lastActivePoolsFetchTimeMS > 60_000) {
    lastActivePoolsFetchTimeMS = currTimeMS;
    const fetchedActivePools = await redisClient
      .hGet(`pools:${chain.key}`, "active-pools")
      .then((v) => JSON.parse(v));

    if (
      JSON.stringify(activePoolTopics) !== JSON.stringify(fetchedActivePools)
    ) {
      activePoolTopics = [...fetchedActivePools];

      const poolDataFetch = [];
      for (const poolTopic of activePoolTopics) {
        const pool = getPoolFromTopic(poolTopic);
        poolDataFetch.push(
          pool.getInitPoolData().then(() => {
            pools[pool.getAddress().toLowerCase()] = pool;
            return redisClient.hSet(
              `pools:${chain.key}`,
              pool.poolId,
              JSON.stringify(pool, (_, v) =>
                typeof v === "bigint" ? v.toString() : v
              )
            );
          })
        );
      }
      await Promise.all(poolDataFetch);

      if (unwatch !== undefined) unwatch();

      const abi = parseAbi([
        "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
        "event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
        "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
      ]);

      unwatch = viemClient.watchEvent({
        events: abi,
        onLogs: (logs) =>
          logs.forEach((log) =>
            processLog({
              ...log,
              ...decodeEventLog({
                abi: abi,
                data: log.data,
                topics: log.topics,
              }),
            })
          ),
      });
    }
  }

  for (const redisUpdate of updateRedisQueue) {
    await redisUpdate();
  }
  updateRedisQueue = [];

  await new Promise((resolve) => setImmediate(resolve));
}
