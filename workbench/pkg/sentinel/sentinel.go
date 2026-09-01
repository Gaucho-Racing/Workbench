package sentinel

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gaucho-racing/workbench/workbench/config"
	"github.com/golang-jwt/jwt/v5"
)

type TokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
	Scope        string `json:"scope"`
}

type User struct {
	ID          string   `json:"id"`
	EntityID    string   `json:"entity_id"`
	Username    string   `json:"username"`
	FirstName   string   `json:"first_name"`
	LastName    string   `json:"last_name"`
	Email       string   `json:"email"`
	AvatarURL   string   `json:"avatar_url"`
	InitialRole string   `json:"initial_role"`
	Groups      []string `json:"groups"`
}

var httpClient = &http.Client{Timeout: 10 * time.Second}
var authClient = &http.Client{Timeout: 20 * time.Second}

func ValidateToken(token string) (map[string]interface{}, error) {
	claims := jwt.MapClaims{}
	parsed, err := jwt.ParseWithClaims(token, claims, func(token *jwt.Token) (interface{}, error) {
		kid, _ := token.Header["kid"].(string)
		return lookupKey(kid)
	}, jwt.WithValidMethods([]string{"RS256"}))
	if err != nil {
		return nil, err
	}
	if !parsed.Valid {
		return nil, fmt.Errorf("token is invalid")
	}
	if audience, ok := claims["aud"]; !ok || audience == nil {
		return nil, fmt.Errorf("token has invalid audience")
	}
	return claims, nil
}

func ExchangeAuthorizationCode(code string, redirectURI string) (TokenResponse, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", redirectURI)
	return exchangeToken(form)
}

func RefreshToken(refreshToken string) (TokenResponse, error) {
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", refreshToken)
	return exchangeToken(form)
}

func GetCurrentUser(accessToken string, userID string) (User, error) {
	requestURL := strings.TrimRight(config.SentinelURL, "/") + "/api/users/" + url.PathEscape(userID)
	req, err := http.NewRequest(http.MethodGet, requestURL, nil)
	if err != nil {
		return User{}, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)

	resp, err := httpClient.Do(req)
	if err != nil {
		return User{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return User{}, fmt.Errorf("sentinel returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var user User
	if err := json.NewDecoder(resp.Body).Decode(&user); err != nil {
		return User{}, err
	}
	return user, nil
}

func exchangeToken(form url.Values) (TokenResponse, error) {
	if config.SentinelClientID == "" || config.SentinelClientSecret == "" {
		return TokenResponse{}, fmt.Errorf("Sentinel OAuth client is not configured")
	}
	form.Set("client_id", config.SentinelClientID)
	form.Set("client_secret", config.SentinelClientSecret)

	req, err := http.NewRequest(http.MethodPost, strings.TrimRight(config.SentinelURL, "/")+"/api/oauth/token", strings.NewReader(form.Encode()))
	if err != nil {
		return TokenResponse{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := authClient.Do(req)
	if err != nil {
		return TokenResponse{}, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return TokenResponse{}, err
	}
	if resp.StatusCode != http.StatusOK {
		return TokenResponse{}, fmt.Errorf("sentinel returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var response TokenResponse
	if err := json.Unmarshal(body, &response); err != nil {
		return TokenResponse{}, err
	}
	if response.AccessToken == "" {
		return TokenResponse{}, fmt.Errorf("Sentinel response did not include an access token")
	}
	return response, nil
}
