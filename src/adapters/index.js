import BitcoinAdapter from './bitcoinAdapter';
import BitsharesAdapter from './bitsharesAdapter';
import EthereumAdapter from './ethereumAdapter';

export const getBlockchain = (blockchain) => {
  switch (blockchain) {
    case 'BTC':
      return new BitcoinAdapter();
    case 'ETH':
      return new EthereumAdapter();
    case 'BTS':
      return new BitsharesAdapter();
    default:
      throw new Error('Unknown Blockchain Passed');
  }
}

export { BitcoinAdapter, BitsharesAdapter, EthereumAdapter };