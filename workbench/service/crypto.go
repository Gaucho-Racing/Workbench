package service

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"fmt"
	"io"

	"github.com/gaucho-racing/workbench/workbench/config"
)

func encryptSecret(value string) ([]byte, error) {
	gcm, err := secretCipher()
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, []byte(value), nil), nil
}

func decryptSecret(value []byte) (string, error) {
	gcm, err := secretCipher()
	if err != nil {
		return "", err
	}
	if len(value) < gcm.NonceSize() {
		return "", fmt.Errorf("encrypted secret is malformed")
	}
	nonce, ciphertext := value[:gcm.NonceSize()], value[gcm.NonceSize():]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("decrypt secret: %w", err)
	}
	return string(plaintext), nil
}

func secretCipher() (cipher.AEAD, error) {
	block, err := aes.NewCipher(config.TargetEncryptionKey)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
