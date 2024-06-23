import TokenList from "./tokenList.json" assert { type: "json" };
import IERC20ABI from "@uniswap/v2-core/build/IERC20.json" assert { type: "json" };
import { Token } from "@uniswap/sdk-core";
import { getContract } from "viem";
import * as viemChains from "viem/chains";

export const getToken = (chainId, symbol) => {
  const token = TokenList.tokens.find(
    (v) => v.chainId === chainId && v.symbol === symbol
  );
  return new Token(chainId, token.address, token.decimals, token.symbol);
};

export const chains = Object.entries(viemChains).map(([k, v]) => ({
  key: k,
  ...v,
}));

const getERC20Contract = (address, client) =>
  getContract({ address: address, abi: IERC20ABI.abi, client: client });

export const getERC20Balance = async (address, erc20Address, client) => {
  const erc20Contract = getERC20Contract(erc20Address, client);
  return erc20Contract.read.balanceOf([address]);
};
