package com.zcode.picman.repository;

import com.zcode.picman.domain.UserRow;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

@Repository
public class UserRepository {

    private static final RowMapper<UserRow> MAPPER = (rs, i) -> new UserRow(
            rs.getLong("id"),
            rs.getString("username"),
            rs.getString("password_hash"),
            rs.getString("created_at"));

    private final JdbcTemplate jdbc;

    public UserRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public long count() {
        Long n = jdbc.queryForObject("SELECT COUNT(*) FROM app_user", Long.class);
        return n == null ? 0 : n;
    }

    public Optional<UserRow> findByUsername(String username) {
        List<UserRow> rows = jdbc.query(
                "SELECT * FROM app_user WHERE username = ?", MAPPER, username);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    /**
     * 只在还没有任何管理员时插入，返回是否真的插入了。
     * <p>
     * 关键在于这是一条原子语句（{@code INSERT ... SELECT ... WHERE NOT EXISTS}）。
     * 不能写成「先 count 再 insert」—— /api/setup/init 是公开接口，
     * 两个并发请求会同时看到 0 然后各插一个管理员，首次部署时存在被抢注的风险。
     */
    public boolean insertFirstIfEmpty(String username, String passwordHash) {
        int rows = jdbc.update("""
                INSERT INTO app_user (username, password_hash, created_at)
                SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM app_user)
                """, username, passwordHash, Instant.now().toString());
        return rows > 0;
    }

    public void updatePassword(String username, String passwordHash) {
        jdbc.update("UPDATE app_user SET password_hash = ? WHERE username = ?", passwordHash, username);
    }
}
