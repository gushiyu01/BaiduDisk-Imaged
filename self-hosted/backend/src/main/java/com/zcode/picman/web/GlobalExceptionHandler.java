package com.zcode.picman.web;

import com.zcode.picman.baidu.BaiduPanException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 把异常翻译成前端约定的 {error, message} 结构。
 * message 一律保留真实原因，前端直接展示给用户，不要吞掉细节。
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    public record ApiError(String error, String message) {
    }

    @ExceptionHandler(BaiduPanException.class)
    public ResponseEntity<ApiError> handleBaidu(BaiduPanException e) {
        if (e.isAuthFailure()) {
            // 授权失效是用户可自行修复的状态，不该记成错误日志
            log.info("百度网盘授权失效：{}", e.getMessage());
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .body(new ApiError("TOKEN_EXPIRED", e.getMessage()));
        }
        if (e.isQuotaExceeded()) {
            return ResponseEntity.status(HttpStatus.INSUFFICIENT_STORAGE)
                    .body(new ApiError("QUOTA_EXCEEDED", e.getMessage()));
        }
        if (e.isNotFound()) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(new ApiError("NOT_FOUND", e.getMessage()));
        }
        log.warn("百度网盘接口失败：{}", e.getMessage());
        return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                .body(new ApiError("UPSTREAM_FAILED", e.getMessage()));
    }

    /** 未实现的占位能力走这里，明确告诉调用方「不支持」而不是伪装成功 */
    @ExceptionHandler(UnsupportedOperationException.class)
    public ResponseEntity<ApiError> handleUnsupported(UnsupportedOperationException e) {
        return ResponseEntity.status(HttpStatus.NOT_IMPLEMENTED)
                .body(new ApiError("NOT_IMPLEMENTED", e.getMessage()));
    }

    @ExceptionHandler(com.zcode.picman.support.ApiException.class)
    public ResponseEntity<ApiError> handleApi(com.zcode.picman.support.ApiException e) {
        return ResponseEntity.status(e.getStatus()).body(new ApiError(e.getCode(), e.getMessage()));
    }

    /**
     * 路径不存在时 Spring 会抛 NoResourceFoundException。
     * 不单独处理的话会落到下面的兜底分支被当成 500，把「没这个接口」误报成「服务器出错」。
     */
    @ExceptionHandler(org.springframework.web.servlet.resource.NoResourceFoundException.class)
    public ResponseEntity<ApiError> handleNoResource(
            org.springframework.web.servlet.resource.NoResourceFoundException e) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND)
                .body(new ApiError("NOT_FOUND", "接口或资源不存在：" + e.getResourcePath()));
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<ApiError> handleIllegalArgument(IllegalArgumentException e) {
        return ResponseEntity.badRequest().body(new ApiError("BAD_REQUEST", e.getMessage()));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiError> handleValidation(MethodArgumentNotValidException e) {
        Map<String, String> fields = new LinkedHashMap<>();
        e.getBindingResult().getFieldErrors().forEach(f -> fields.put(f.getField(), f.getDefaultMessage()));
        String msg = fields.isEmpty() ? "请求参数不合法" : String.join("；", fields.values());
        return ResponseEntity.badRequest().body(new ApiError("VALIDATION_FAILED", msg));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiError> handleOther(Exception e) {
        log.error("未处理的异常", e);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(new ApiError("INTERNAL_ERROR", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
    }
}
