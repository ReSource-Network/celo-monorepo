import {
  authenticateUser,
  ErrorMessage,
  hasValidAccountParam,
  hasValidQueryPhoneNumberParam,
  hasValidTimestamp,
  isBodyReasonablySized,
  phoneNumberHashIsValidIfExists,
  SignMessageResponse,
  SignMessageResponseFailure,
  WarningMessage,
} from '@celo/phone-number-privacy-common'
import Logger from 'bunyan'
import { Request, Response } from 'express'
import { computeBlindedSignature } from '../bls/bls-cryptography-client'
import { respondWithError } from '../common/error-utils'
import { Counters, Labels } from '../common/metrics'
import { getVersion } from '../config'
import { incrementQueryCount } from '../database/wrappers/account'
import { getRequestExists, storeRequest } from '../database/wrappers/request'
import { getKeyProvider } from '../key-management/key-provider'
import { Endpoints } from '../server'
import { getBlockNumber, getContractKit } from '../web3/contracts'
import { getRemainingQueryCount } from './query-quota'

export interface GetBlindedMessagePartialSigRequest {
  account: string
  blindedQueryPhoneNumber: string
  hashedPhoneNumber?: string
  timestamp?: number
  sessionID?: string
}

export async function handleGetBlindedMessagePartialSig(
  request: Request<{}, {}, GetBlindedMessagePartialSigRequest>,
  response: Response
) {
  Counters.requests.labels(Endpoints.GET_BLINDED_MESSAGE_PARTIAL_SIG).inc()

  const logger: Logger = response.locals.logger
  logger.info('Begin handleGetBlindedMessagePartialSig request')

  if (!request.body.sessionID) {
    Counters.signatureRequestsWithoutSessionID.inc()
  }

  try {
    if (!isValidGetSignatureInput(request.body)) {
      respondWithError(
        Endpoints.GET_BLINDED_MESSAGE_PARTIAL_SIG,
        response,
        400,
        WarningMessage.INVALID_INPUT
      )
      return
    }
    if (!(await authenticateUser(request, getContractKit(), logger))) {
      respondWithError(
        Endpoints.GET_BLINDED_MESSAGE_PARTIAL_SIG,
        response,
        401,
        WarningMessage.UNAUTHENTICATED_USER
      )
      return
    }

    const { account, blindedQueryPhoneNumber, hashedPhoneNumber } = request.body

    const errorMsgs: string[] = []
    // In the case of a DB or blockchain connection failure, don't block user
    // but set the error status accordingly
    const [_queryCount, _blockNumber] = await Promise.allSettled([
      getRemainingQueryCount(logger, account, hashedPhoneNumber).catch((err) => {
        Counters.databaseErrors.labels(Labels.read).inc()
        logger.error('Failed to get user quota')
        logger.error({ err })
        errorMsgs.push(ErrorMessage.DATABASE_GET_FAILURE)
        return undefined
      }),
      getBlockNumber().catch((err) => {
        Counters.blockchainErrors.labels(Labels.read).inc()
        logger.error('Failed to get latest block number')
        logger.error({ err })
        errorMsgs.push(ErrorMessage.CONTRACT_GET_FAILURE)
        return undefined
      }),
    ])

    let totalQuota,
      performedQueryCount = -1
    if (_queryCount.status === 'fulfilled') {
      performedQueryCount = _queryCount.value!.performedQueryCount
      totalQuota = _queryCount.value!.totalQuota
    }
    const blockNumber = _blockNumber.status === 'fulfilled' ? _blockNumber.value : -1

    if (
      !errorMsgs.includes(ErrorMessage.DATABASE_GET_FAILURE) &&
      performedQueryCount >= totalQuota
    ) {
      logger.debug('No remaining query count')
      respondWithError(
        Endpoints.GET_BLINDED_MESSAGE_PARTIAL_SIG,
        response,
        403,
        WarningMessage.EXCEEDED_QUOTA,
        performedQueryCount,
        totalQuota,
        blockNumber
      )
      return
    }

    const keyProvider = getKeyProvider()
    const privateKey = keyProvider.getPrivateKey()
    const signature = computeBlindedSignature(blindedQueryPhoneNumber, privateKey, logger)

    if (await getRequestExists(request.body, logger)) {
      Counters.duplicateRequests.inc()
      logger.debug(
        'Signature request already exists in db. Will not store request or increment query count.'
      )
      errorMsgs.push(WarningMessage.DUPLICATE_REQUEST_TO_GET_PARTIAL_SIG)
    } else {
      if (!(await storeRequest(request.body, logger))) {
        logger.debug('Did not store request.')
        errorMsgs.push(ErrorMessage.FAILURE_TO_STORE_REQUEST)
      }
      if (!(await incrementQueryCount(account, logger))) {
        logger.debug('Did not increment query count.')
        errorMsgs.push(ErrorMessage.FAILURE_TO_INCREMENT_QUERY_COUNT)
      } else {
        performedQueryCount++
      }
    }

    let signMessageResponse: SignMessageResponse
    const signMessageResponseSuccess: SignMessageResponse = {
      success: !errorMsgs.length,
      signature,
      version: getVersion(),
      performedQueryCount,
      totalQuota,
      blockNumber,
    }
    if (errorMsgs.length) {
      const signMessageResponseFailure = signMessageResponseSuccess as SignMessageResponseFailure
      signMessageResponseFailure.error = errorMsgs.join(', ')
      signMessageResponse = signMessageResponseFailure
    } else {
      signMessageResponse = signMessageResponseSuccess
    }
    logger.debug('Signature retrieval success')
    response.json(signMessageResponse)
  } catch (err) {
    logger.error('Failed to get signature')
    logger.error({ err })
    respondWithError(
      Endpoints.GET_BLINDED_MESSAGE_PARTIAL_SIG,
      response,
      500,
      ErrorMessage.UNKNOWN_ERROR
    )
  }
}

function isValidGetSignatureInput(requestBody: GetBlindedMessagePartialSigRequest): boolean {
  return (
    hasValidAccountParam(requestBody) &&
    hasValidQueryPhoneNumberParam(requestBody) &&
    phoneNumberHashIsValidIfExists(requestBody) &&
    isBodyReasonablySized(requestBody) &&
    hasValidTimestamp(requestBody)
  )
}
