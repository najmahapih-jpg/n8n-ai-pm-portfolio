@{
  SensitiveNames = @(
    'authorization'
    'cookie'
    'xapikey'
    'apikey'
    'accesstoken'
    'refreshtoken'
    'clientsecret'
    'client_secret'
    'password'
    'token'
    'secret'
    'sessiontoken'
  )

  RawSecretPatterns = @(
    '"credentials"\s*:'
    '"usedCredentials"\s*:'
    'sk-[A-Za-z0-9_\-]{20,}'
    'Bearer\s+[A-Za-z0-9_\.\-/+=]{20,}'
    '(?i)"(authorization|cookie|x-api-key|apiKey|accessToken|refreshToken|clientSecret|client_secret|password|token|secret|sessionToken)"\s*:\s*"(?!__SCRUBBED__")'
    '[A-Za-z]:\\Users\\'
    '"\s*:\s*"/(Users|home|etc|var|tmp)/'
    'https://open\.(feishu|larksuite)\.com/open-apis/bot/v2/hook/[A-Za-z0-9_\-]+'
  )

  RepositorySecretPatterns = @(
    'sk-[A-Za-z0-9_\-]{20,}'
    'Bearer\s+[A-Za-z0-9_\.\-/+=]{20,}'
    '(?i)"(authorization|cookie|x-api-key|apiKey|accessToken|refreshToken|clientSecret|client_secret|password|token|secret|sessionToken)"\s*:\s*"(?!__SCRUBBED__")'
    '[A-Za-z]:\\Users\\'
    '"\s*:\s*"/(Users|home|etc|var|tmp)/'
    'https://open\.(feishu|larksuite)\.com/open-apis/bot/v2/hook/[A-Za-z0-9_\-]+'
  )
}
