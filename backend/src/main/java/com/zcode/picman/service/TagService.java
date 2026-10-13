package com.zcode.picman.service;

import com.zcode.picman.domain.TagRow;
import com.zcode.picman.repository.TagRepository;
import com.zcode.picman.support.ApiException;
import com.zcode.picman.web.dto.Dtos.TagDto;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.regex.Pattern;

@Service
public class TagService {

    private static final Pattern COLOR = Pattern.compile("^#[0-9A-Fa-f]{6}$");
    private static final int MAX_NAME_LENGTH = 32;
    private static final String DEFAULT_COLOR = "#409EFF";

    private final TagRepository tags;

    public TagService(TagRepository tags) {
        this.tags = tags;
    }

    public List<TagDto> list() {
        return tags.findAllWithCount().stream().map(TagDto::of).toList();
    }

    public TagDto create(String name, String color) {
        String cleanName = validateName(name);
        if (tags.findByName(cleanName).isPresent()) {
            throw ApiException.conflict("标签已存在：" + cleanName);
        }
        long id = tags.insert(cleanName, validateColor(color));
        return tags.findById(id).map(TagDto::of)
                .orElseThrow(() -> new IllegalStateException("创建标签后读取失败"));
    }

    public TagDto update(long id, String name, String color) {
        TagRow existing = tags.findById(id).orElseThrow(() -> ApiException.notFound("标签不存在（id=" + id + "）"));
        String newName = name == null || name.isBlank() ? existing.name() : validateName(name);
        String newColor = color == null || color.isBlank() ? existing.color() : validateColor(color);

        tags.findByName(newName).ifPresent(other -> {
            if (other.id() != id) {
                throw ApiException.conflict("已有同名标签：" + newName);
            }
        });
        tags.update(id, newName, newColor);
        return tags.findById(id).map(TagDto::of)
                .orElseThrow(() -> new IllegalStateException("更新标签后读取失败"));
    }

    /** 删除标签会连带解除与图片的关联（靠外键 ON DELETE CASCADE） */
    @Transactional
    public void delete(long id) {
        if (tags.findById(id).isEmpty()) {
            throw ApiException.notFound("标签不存在（id=" + id + "）");
        }
        tags.delete(id);
    }

    private static String validateName(String name) {
        String clean = name == null ? "" : name.trim();
        if (clean.isEmpty()) {
            throw ApiException.badRequest("标签名不能为空");
        }
        if (clean.length() > MAX_NAME_LENGTH) {
            throw ApiException.badRequest("标签名不能超过 %d 个字符".formatted(MAX_NAME_LENGTH));
        }
        return clean;
    }

    private static String validateColor(String color) {
        if (color == null || color.isBlank()) {
            return DEFAULT_COLOR;
        }
        String clean = color.trim();
        if (!COLOR.matcher(clean).matches()) {
            throw ApiException.badRequest("颜色需为 #RRGGBB 格式，收到：" + clean);
        }
        return clean.toUpperCase();
    }
}
