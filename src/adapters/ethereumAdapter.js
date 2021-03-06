import { postRequest, getRequest } from "../lib/request";
import envConfig from "../../config/envConfig";
import { getConnection } from "typeorm";
import { User } from "../entity/user";
import { Transfer } from "../entity/transfer";
import { BadRequestError } from '../errors';
import BigNumber from 'bignumber.js';
import Web3 from 'web3'; // to get web3 to work.
import { validate } from 'wallet-address-validator';

/* required constants for ethereum adapter */
// this.web3 = new Web3(new Web3.providers.HttpProvider(ETHEREUM_NODE_URL))
const ethEnvironment = envConfig.get('env');
const etherscanApiURL = ethEnvironment === 'development' ? envConfig.get('ethscanTestBaseUrl') : envConfig.get('ethscanMainBaseUrl');
const vaultBaseUrl = envConfig.get("vaultBaseUrl");
const priceApiKey = envConfig.get("priceApiKey");
const vaultToken = envConfig.get("vaultToken");
const priceBaseUrl = envConfig.get("priceBaseUrl");
const addrEnv = ethEnvironment === 'development' ? 'testnet' : 'prod';
const ethChainId = ethEnvironment === 'development' ? 3 : 1; // 1 for mainnet and 3 for testnet
const ethereumNodeURL = ethEnvironment === 'development' ? envConfig.get('ethTestBaseUrl') : envConfig.get('ethMainBaseUrl');

if (typeof web3 !== 'undefined') {
  var web3 = new Web3(web3.currentProvider);
} else {
  var web3 = new Web3(new Web3.providers.HttpProvider(ethereumNodeURL));
}

class EthereumAdapter {

  constructor(name) {
    this.name = name;
  }

  getAddress = (headers, accountName) =>
    new Promise(async (resolve, reject) => {
      const uuid = await this._getUuid(accountName);
      if (!uuid) {
        return reject(new BadRequestError('Account does not exists'));
      }
      return this._getAddress(headers, uuid)
        .then(address => resolve({ 'ETH': address }))
        .catch(reject)
    });

  getBalance = (headers, accountName) =>
    new Promise(async (resolve, reject) => {
      const uuid = await this._getUuid(accountName);
      if (!uuid) {
        return reject(new BadRequestError('Account does not exists'));
      }
      return this._getAddress(headers, uuid)
        .then(res => {
          const balance = web3.eth.getBalance(res);
          return resolve({ accountName, balance: new BigNumber(parseInt(balance, 10)).div(1000000000000000000).toString(), unit: 'ETH' });
        })
        .catch(reject)
    })

  getPrice = (coin, query) =>
    new Promise((resolve, reject) => {
      if (coin === 'ETH' || coin === 'UDOO') {
        const currency = query.currency || 'USD';
        const url = `${priceBaseUrl}/data/price?fsym=${coin}&tsyms=${currency}`;
        const headers = { Apikey: priceApiKey };
        return getRequest(url, {}, headers)
          .then(result => {
            if (result.Response === 'Error' && result.Message === `There is no data for any of the toSymbols ${currency} .`) {
              return reject(new BadRequestError('Invalid Currency'));
            }
            return resolve({ coin, [currency]: result[currency] })
          })
          .catch(reject);
      }
      else {
        return reject(new BadRequestError('Coin and Blockchain mismatched'));
      }
    });

  transfer = req =>
    new Promise(async (resolve, reject) => {
      let fromAccountAddress, toAccountAddress;
      if (!req.body.fromAccount) {
        return reject(new BadRequestError('fromAccount is mandatory'));
      }
      if (!req.body.toAccount) {
        return reject(new BadRequestError('toAccount is mandatory'));
      }
      if (!req.body.sendAmount) {
        return reject(new BadRequestError('sendAmount is mandatory'));
      }
      const fromAccountUUID = await this._getUuid(req.body.fromAccount);
      if (!fromAccountUUID) {
        return reject(new BadRequestError('sender account does not exists'));
      }
      const toAccountUUID = await this._getUuid(req.body.toAccount);
      if (!toAccountUUID) {
        return reject(new BadRequestError('receiver account does not exists'));
      }
      if (validate(req.body.fromAccount, 'ETH', addrEnv)) {
        fromAccountAddress = req.body.fromAccount;
      } else {
        fromAccountAddress = await this._getAddress(req.headers, fromAccountUUID);
      }
      if (validate(req.body.toAccount, 'ETH', addrEnv)) {
        toAccountAddress = req.body.fromAccount;
      } else {
        toAccountAddress = await this._getAddress(req.headers, toAccountUUID);
      }
      const gasPrice = await this._getGasPrice();
      const gasLimit = await this._getGas("", fromAccountAddress, toAccountAddress);
      const amount = await this._getWeiFromEth(req.body.sendAmount);
      const nounce = await this._getNounce(fromAccountAddress);

      const payload = {
        nonce: nounce,
        value: Number(amount),
        gasLimit: gasLimit,
        gasPrice: gasPrice,
        to: toAccountAddress,
        data: "", // empty for a regular transfer.
        chainId: ethChainId
      }
      return this._signTransaction(payload, fromAccountUUID)
        .then(signedTransaction => {
          const transactionHash = web3.eth.sendRawTransaction(signedTransaction.signature);
          return transactionHash;
        })
        .then(async(res) => {
          const connection = getConnection();
          const transfer = new Transfer();
          const price = await this.getPrice('ETH', 'USD');
          const valueUSD = new BigNumber(req.body.sendAmount).multipliedBy(price.USD).toNumber();
          transfer.txn_id = res;
          transfer.from = req.body.fromAccount;
          transfer.to = req.body.toAccount;
          transfer.amount = new BigNumber(req.body.sendAmount).multipliedBy(1000000000000000000).toNumber();
          transfer.value_USD = valueUSD;
          transfer.coin_id = 'ETH';
          transfer.txn_status = 'PENDING';
          transfer.txn_date = new Date();
          return connection.manager.save(transfer)
        })
        .then(txn => resolve({ TransactionId: txn.txn_id }))
        .catch(reject);
    });

  getTransactionHistory = (headers, accountName) =>
    new Promise(async (resolve, reject) => {
      const uuid = await this._getUuid(accountName);
      if (!uuid) {
        return reject(new BadRequestError('Account does not exists'));
      }
      return this._getAddress(headers, uuid)
        .then(address => resolve({ url: `${etherscanApiURL}/address/${address}` }))
        .catch(reject)
    })

  getStatus = (blockchain, txnId) =>
    new Promise(async (resolve, reject) => {
      const connection = getConnection();
      const TransferRepository = connection.getRepository(Transfer);
      const transaction = await TransferRepository.findOne({ txn_id: txnId, coin_id: blockchain });
      if (!transaction) {
        return reject(new BadRequestError('Transaction does not exists'));
      }
      return resolve(transaction);
    })

  _registerUserToVault = req =>
    new Promise((resolve, reject) => {
      const url = `${vaultBaseUrl}/api/register`;
      const headers = { "x-vault-token": vaultToken };
      return postRequest(url, {}, headers)
        .then(resolve)
        .catch(reject);
    });

  _getAddress = (headers, uuid) =>
    new Promise((resolve, reject) => {
      const body = {
        coinType: 60,
        path: "m/44'/60'/0'/0/0",
        uuid: uuid
      };
      const url = `${vaultBaseUrl}/api/address`;
      const vaultHeaders = { "x-vault-token": vaultToken };
      return postRequest(url, body, vaultHeaders)
        .then(res => resolve(res.data.address))
        .catch(reject);
    });

  _getUuid = async (account) => {
    const connection = getConnection();
    const UserRepository = connection.getRepository(User);
    const registrar = await UserRepository.findOne({ name: account });
    if (!registrar) return false;
    return registrar.vault_uuid;
  }

  _getGas = async (data, from, to) => {
    const gas = await web3.eth.estimateGas({ data, from, to });
    return gas;
  }

  _getGasPrice = async () => {
    const gasPrice = await (web3.eth.gasPrice * 1.5);
    return gasPrice;
  }

  _getNounce = async (fromAccount) => {
    const nounce = await web3.eth.getTransactionCount(fromAccount);
    return nounce;
  }

  _getWeiFromEth = async (amount) => web3.toWei(amount, 'ether')

  _signTransaction = (payload, fromAccountUUID) =>
    new Promise(async (resolve, reject) => {
      const url = `${vaultBaseUrl}/api/signature`;
      const body = {
        "coinType": 60,
        "path": "m/44'/60'/0'/0/0",
        "payload": JSON.stringify(payload),
        "uuid": fromAccountUUID
      }
      const headers = {
        "x-vault-token": vaultToken,
        "Content-Type": "application/json"
      };
      return postRequest(url, body, headers)
        .then(res => resolve(res.data))
        .catch(reject);
    });
}

export default EthereumAdapter;
