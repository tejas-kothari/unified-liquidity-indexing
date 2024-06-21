import "dotenv/config";
import TokenList from "./tokenList.json" assert { type: "json" };
import MulticallWrapperPkg from "ethers-multicall-provider";
const { MulticallWrapper } = MulticallWrapperPkg;
import { ethers } from "ethers";
import { Token } from "@uniswap/sdk-core";

export const getToken = (chainId, symbol) => {
  const token = TokenList.tokens.find(
    (v) => v.chainId === chainId && v.symbol === symbol
  );
  return new Token(chainId, token.address, token.decimals, token.symbol);
};

const chains = Object.fromEntries(
  Object.entries({
    mainnet: {
      chainId: 1,
      rpc: process.env.MAINNET_RPC,
      uniV3FactoryAddress: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    },
    base: {
      chainId: 8453,
      rpc: process.env.BASE_RPC,
      uniV3FactoryAddress: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    },
  }).map(([k, v]) => [k, { key: k, ...v }])
);

export const getProvider = (rpcUrl) => {
  return MulticallWrapper.wrap(new ethers.WebSocketProvider(rpcUrl));
};

export default chains;
