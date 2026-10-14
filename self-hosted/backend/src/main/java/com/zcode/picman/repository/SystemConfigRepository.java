package com.zcode.picman.repository;

import com.zcode.picman.support.DbDialect;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

@Repository
public class SystemConfigRepository {

    private final JdbcTemplate jdbc;
    private final DbDialect dialect;

    public SystemConfigRepository(JdbcTemplate jdbc, DbDialect dialect) {
        this.jdbc = jdbc;
        this.dialect = dialect;
    }

    public Optional<String> find(String key) {
        List<String> rows = jdbc.queryForList(
                "SELECT config_val FROM system_config WHERE config_key = ?", String.class, key);
        return rows.isEmpty() ? Optional.empty() : Optional.ofNullable(rows.get(0));
    }

    public String getOr(String key, String fallback) {
        return find(key).orElse(fallback);
    }

    public void put(String key, String value) {
        jdbc.update(dialect.upsertConfigSql(), key, value, Instant.now().toString());
    }

    public void delete(String key) {
        jdbc.update("DELETE FROM system_config WHERE config_key = ?", key);
    }
}
