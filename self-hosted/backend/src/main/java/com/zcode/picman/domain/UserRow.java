package com.zcode.picman.domain;

public record UserRow(long id, String username, String passwordHash, String createdAt) {
}
