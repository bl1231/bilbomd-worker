import axios from 'axios'
import jwt from 'jsonwebtoken'
import fs from 'fs'
import { logger } from '../../helpers/loggers'

const tokenUrl = 'https://oidc.nersc.gov/c2id/token'
const clientId = process.env.SFAPI_CLIENT_ID as string
const privateKeyPath = '/secrets/priv_key.pem'

let cachedToken: string | null = null
let tokenExpiry: number | null = null

// Generate a JWT for client assertion
const generateClientAssertion = (): string => {
  const privateKey = fs.readFileSync(privateKeyPath, 'utf8')
  const payload = {
    iss: clientId,
    sub: clientId,
    aud: tokenUrl,
    exp: Math.floor(Date.now() / 1000) + 5 * 60 // Current time + 5 minutes
  }
  const assertion = jwt.sign(payload, privateKey, { algorithm: 'RS256' })
  return assertion
}

// Exchange clientAssertion for an accessToken
const getAccessToken = async (clientAssertion: string): Promise<string> => {
  const params = new URLSearchParams()
  params.append('grant_type', 'client_credentials')
  params.append(
    'client_assertion_type',
    'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
  )
  params.append('client_assertion', clientAssertion)

  try {
    const response = await axios.post(tokenUrl, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    })
    const accessToken = response.data.access_token
    const expiresIn = response.data.expires_in

    // Update cache
    cachedToken = accessToken
    tokenExpiry = Math.floor(Date.now() / 1000) + expiresIn - 10 // Adjust for clock skew

    logger.info(`New access token acquired, expires in ${expiresIn} seconds`)
    return accessToken
  } catch (error) {
    logger.error('Error fetching access token:', error)
    throw error
  }
}

// Ensure the token is valid, renewing if necessary
const ensureValidToken = async (): Promise<string> => {
  if (!cachedToken || !tokenExpiry || tokenExpiry <= Math.floor(Date.now() / 1000)) {
    const clientAssertion = generateClientAssertion()
    return getAccessToken(clientAssertion)
  } else {
    const secondsUntilExpiry = tokenExpiry - Math.floor(Date.now() / 1000)
    logger.info(`Using cached token, expires in ${secondsUntilExpiry} seconds`)
    return cachedToken
  }
}

export { ensureValidToken }
