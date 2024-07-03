import IERC20ABI from "@uniswap/v2-core/build/IERC20.json" assert { type: "json" };
import { getContract } from "viem";
import * as viemChains from "viem/chains";

export const dexes = {
  UniV3: "UniswapV3",
  VeloV3: "VelodromeV3",
};

export const chains = Object.entries(viemChains).map(([k, v]) => ({
  key: k,
  ...v,
}));

const getERC20Contract = (address, client) =>
  getContract({ address: address, abi: IERC20ABI.abi, client: client });

export const getERC20Balance = async (address, erc20Address, client) => {
  const contract = getERC20Contract(erc20Address, client);
  return contract.read.balanceOf([address]);
};

export const getERC20Metadata = (address, client) => {
  const contract = getERC20Contract(address, client);
  return Promise.all([
    contract.read.name(),
    contract.read.symbol(),
    contract.read.decimals(),
  ]);
};
