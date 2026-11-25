package com.example.lensmind.ai;

import org.springframework.http.HttpStatus;

public class AiException extends RuntimeException {
    private final HttpStatus status;
    private final String code;
    public AiException(HttpStatus status, String code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }
    public HttpStatus status() { return status; }
    public String code() { return code; }
    public static AiException badInput(String message) {
        return new AiException(HttpStatus.BAD_REQUEST, "INVALID_INPUT", message);
    }
    public static AiException badOutput() {
        return new AiException(HttpStatus.BAD_GATEWAY, "INVALID_MODEL_OUTPUT", "模型返回格式或内容不符合约定，请调整模型/提示词后重试");
    }
}
