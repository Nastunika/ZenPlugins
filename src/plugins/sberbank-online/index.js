import { MD5 } from 'jshashes'
import { ensureSyncIDsAreUniqueButSanitized, sanitizeSyncId } from '../../common/accounts'
import { adjustTransactions } from '../../common/transactionGroupHandler'
import { generateRandomString } from '../../common/utils'
import { TemporaryUnavailableError } from '../../errors'
import { fetchAccounts, fetchBrokerAccounts, fetchPayments, fetchTransactions, login, makeTransfer as _makeTransfer } from './api'
import { adjustTransactionsAndCheckBalance, convertAccounts, convertBrokerAccount, convertLoanTransaction, convertTransaction } from './converters'

const md5 = new MD5()

function getAuth () {
  let guid = ZenMoney.getData('mGUID') || ZenMoney.getData('guid')
  if (guid) {
    ZenMoney.setData('mGUID', undefined)
    ZenMoney.setData('guid', undefined)
  }
  let auth = ZenMoney.getData('auth')
  if (guid) {
    if (auth) {
      auth.guid = guid
    } else {
      auth = { guid }
    }
    saveAuth(auth)
  }
  return auth
}

function getDevice ({ login }) {
  let device = ZenMoney.getData('device')
  if (!device) {
    if (ZenMoney.getData('devID') && ZenMoney.getData('devIDOld')) {
      device = {
        id: ZenMoney.getData('devID'),
        idOld: ZenMoney.getData('devIDOld'),
        model: 'Xperia Z2'
      }
    } else if (ZenMoney.getData('devid')) {
      device = {
        id: ZenMoney.getData('devid'),
        idOld: generateRandomString(36) + '0000',
        model: 'Xperia Z2'
      }
    } else {
      device = {
        id: md5.hex(login) + '0000',
        idOld: generateRandomString(36) + '0000',
        model: 'Zenmoney Phone'
      }
    }
    ZenMoney.setData('simId', undefined)
    ZenMoney.setData('imei', undefined)
    ZenMoney.setData('devid', undefined)
    ZenMoney.setData('devID', undefined)
    ZenMoney.setData('devIDOld', undefined)
    ZenMoney.setData('device', device)
  }
  return device
}

function saveAuth (auth) {
  ZenMoney.setData('auth', auth)
}

export async function scrape ({ preferences, fromDate, toDate, isInBackground }) {
  if (preferences.pin.length !== 5) {
    throw new InvalidPreferencesError('Пин-код должен быть из 5 цифр')
  }
  const isFirstRun = !ZenMoney.getData('scrape/lastSuccessDate')
  if (isFirstRun && ZenMoney.getData('devid')) {
    fromDate = new Date(new Date().getTime() - 7 * 24 * 3600 * 1000)
  }

  toDate = toDate || new Date()

  let auth = getAuth()
  if (auth && auth.api) {
    // if (!(await renewSession(auth.api))) {
    delete auth.api
    // }
  }
  if (!auth || !auth.api) {
    auth = await login(preferences.login, preferences.pin, auth, getDevice(preferences))
  }

  saveAuth(auth)

  const { accountData, accountsById } = convertAccounts(await fetchAccounts(auth))

  const accounts = []
  const transactions = []
  const transactionIds = {}

  await Promise.all(accountData.map(async ({ zenAccount: account, products }) => {
    accounts.push(account)
    return ZenMoney.isAccountSkipped(account.id) ? null : Promise.all(products.map(async product => {
      let isBalanceAmbiguous = false
      let apiTransactions
      try {
        apiTransactions = await fetchTransactions(auth, product, fromDate, toDate)
      } catch (e) {
        apiTransactions = []
        if (e instanceof TemporaryUnavailableError) {
          isBalanceAmbiguous = true
        } else {
          throw e
        }
      }
      if (product.type !== 'loan' && product.type !== 'ima' && product.type !== 'iis') {
        const apiPayments = await fetchPayments(auth, product, fromDate, toDate)
        if (isBalanceAmbiguous) {
          apiTransactions = apiPayments
        } else {
          ({ isBalanceAmbiguous, transactions: apiTransactions } = adjustTransactionsAndCheckBalance(apiTransactions, apiPayments))
        }
      }
      for (const apiTransaction of apiTransactions) {
        let transaction
        if (product.type === 'loan') {
          transaction = convertLoanTransaction(apiTransaction, account, accountsById)
        } else {
          transaction = convertTransaction(apiTransaction, account, accountsById)
          if (transaction) {
            const id1 = transaction.movements[0].id
            const id2 = transaction.movements[1] && transaction.movements[1].id ? transaction.movements[1].id : id1
            if (transactionIds[id1] || transactionIds[id2]) {
              continue
            } else {
              transactionIds[id1] = true
              transactionIds[id2] = true
            }
          }
        }
        if (transaction) {
          transactions.push(transaction)
        }
      }
      if (isBalanceAmbiguous && !isFirstRun) {
        delete account.balance
        delete account.available
        account.balance = null
      }
    }))
  }))

  accounts.push(...(await fetchBrokerAccounts(auth))
    .map(convertBrokerAccount)
    .filter(data => data)
    .map(({ zenAccount }) => zenAccount))

  saveAuth(auth)

  return {
    accounts: ensureSyncIDsAreUniqueButSanitized({ accounts, sanitizeSyncId }),
    transactions: adjustTransactions({ transactions })
  }
}

export async function makeTransfer (fromAccount, toAccount, sum) {
  const preferences = ZenMoney.getPreferences()
  const device = getDevice(preferences)
  const auth = await login(preferences.login, preferences.pin, getAuth(), device)
  await _makeTransfer(preferences.login, auth, device, { fromAccount, toAccount, sum })
  saveAuth(auth)
  ZenMoney.saveData()
}
