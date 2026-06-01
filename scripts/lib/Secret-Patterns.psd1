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
    'servicerolekey'
    'service_role_key'
    'servicerole'
    'supabasekey'
    'supabaseservicerolekey'
    'anonkey'
  )

  RawSecretPatterns = @(
    '"credentials"\s*:'
    '"usedCredentials"\s*:'
    'sk-[A-Za-z0-9_\-]{20,}'
    'Bearer\s+[A-Za-z0-9_\.\-/+=]{20,}'
    '(?i)"(authorization|cookie|x-api-key|apiKey|accessToken|refreshToken|clientSecret|client_secret|password|token|secret|sessionToken|service_role_key|serviceRoleKey|supabaseKey|anonKey)"\s*:\s*"(?!__SCRUBBED__")'
    'eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}'
    '[A-Za-z]:\\Users\\'
    '"\s*:\s*"/(Users|home|etc|var|tmp)/'
    'https://[a-z0-9]{20}\.supabase\.co'
  )

  RepositorySecretPatterns = @(
    'sk-[A-Za-z0-9_\-]{20,}'
    'Bearer\s+[A-Za-z0-9_\.\-/+=]{20,}'
    '(?i)"(authorization|cookie|x-api-key|apiKey|accessToken|refreshToken|clientSecret|client_secret|password|token|secret|sessionToken|service_role_key|serviceRoleKey|supabaseKey|anonKey)"\s*:\s*"(?!__SCRUBBED__")'
    'eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}'
    '[A-Za-z]:\\Users\\'
    '"\s*:\s*"/(Users|home|etc|var|tmp)/'
    'https://[a-z0-9]{20}\.supabase\.co'
  )
}
