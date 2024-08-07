import { createClient } from "redis";
import { createPublicClient, decodeEventLog, parseAbi, webSocket } from "viem";
import { chains, dexes, getERC20Metadata } from "./chains.js";
import { UniV3Pool } from "./uniV3Pool.js";
import { VeloV3Pool } from "./veloV3Pool.js";
import commandLineArgs from "command-line-args";
import { Token } from "@uniswap/sdk-core";

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

BigInt.prototype.toJSON = function () {
  return this.toString();
};

const factoryAddresses = {};
const factoryFetch = [];
for (const dex of Object.keys(dexes)) {
  factoryFetch.push(
    redisClient
      .get(`pools:${chain.key}:${dex}:factory`)
      .then((v) => (factoryAddresses[dex] = v))
  );
}
await Promise.all(factoryFetch);

const tokens = {};
const tokenList = await redisClient.hGetAll(`tokens:${chain.key}`);
for (const tokenAddress in tokenList) {
  const tokenMetadata = JSON.parse(tokenList[tokenAddress]);
  tokens[tokenAddress] = new Token(
    chainId,
    tokenAddress,
    tokenMetadata.decimals,
    tokenMetadata.symbol,
    tokenMetadata.name
  );
}

const getToken = async (address) => {
  if (tokens[address] !== undefined) {
    return tokens[address];
  }

  const [name, symbol, decimals] = await getERC20Metadata(address, viemClient);

  await redisClient.hSet(
    `tokens:${chain.key}`,
    address,
    JSON.stringify({ name, symbol, decimals })
  );

  const token = new Token(chainId, address, decimals, symbol, name);
  tokens[address] = token;

  return token;
};

const getPoolFromTopic = async (poolTopic) => {
  const identifers = poolTopic.split(/[:/]/);
  const dex = identifers[0];
  const [token0, token1] = await Promise.all([
    getToken(identifers[1]),
    getToken(identifers[2]),
  ]);
  const numericalIdentifers = identifers.slice(3);
  const fee = Number(
    numericalIdentifers.find((v) => v.includes("bp"))?.replace("bp", "")
  );
  const tickSpacing = Number(
    numericalIdentifers.find((v) => v.includes("ts"))?.replace("ts", "")
  );

  let pool;

  if (dex === "UniV3") {
    pool = new UniV3Pool(
      token0,
      token1,
      fee,
      tickSpacing,
      factoryAddresses.UniV3,
      chain,
      viemClient
    );
  } else if (dex === "VeloV3") {
    pool = new VeloV3Pool(
      token0,
      token1,
      fee,
      tickSpacing,
      factoryAddresses.VeloV3,
      chain,
      viemClient
    );
  }

  return pool;
};

const processLog = (log) => {
  const pool = pools?.[log.address.toLowerCase()];
  if (pool === undefined) return;

  console.log(`${pool.getPoolString()}[${log.eventName}]`);
  console.log(log);

  pool.updatePoolDataFromLog(log);

  updateRedisQueue.push(() =>
    pool.pushToRedis(redisClient, redisPubClient, PUB_CHANNEL)
  );
};

while (true) {
  const currTimeMS = new Date().getTime();

  if (currTimeMS - lastActivePoolsFetchTimeMS > 60_000) {
    lastActivePoolsFetchTimeMS = currTimeMS;
    const fetchedActivePools = await redisClient.hKeys(
      `pools:${chain.key}:active-pools`
    );

    if (
      JSON.stringify(activePoolTopics) !== JSON.stringify(fetchedActivePools)
    ) {
      activePoolTopics = [...fetchedActivePools];
      const blockNumber = await viemClient.getBlockNumber();

      const poolDataFetch = [];
      for (const poolTopic of activePoolTopics) {
        const pool = await getPoolFromTopic(poolTopic);
        poolDataFetch.push(
          pool.getInitPoolData(blockNumber).then(() => {
            pools[pool.getContractAddress().toLowerCase()] = pool;
            return pool.pushToRedis(redisClient, redisPubClient, PUB_CHANNEL);
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
        fromBlock: blockNumber + 1n,
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
