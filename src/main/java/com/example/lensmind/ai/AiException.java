package com.example.lensmind.ai;

final class AiException extends RuntimeException {
    final int status;

    AiException(int status, String message) {
        super(message);
        this.status = status;
    }
}
