require('dotenv').config();
const { 
    Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, 
    ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, 
    TextInputBuilder, TextInputStyle, PermissionsBitField 
} = require('discord.js');
const { Pool } = require('pg');
const http = require('http');

const TOKEN = process.env.DISCORD_TOKEN ? process.env.DISCORD_TOKEN.trim() : '';
const DATABASE_URL = process.env.DATABASE_URL ? process.env.DATABASE_URL.trim() : '';
const DEFAULT_GENERATOR = process.env.GENERATOR_NAME || '➕・Tạo Phòng';
const FIXED_BLOG_NAME = process.env.BLOG_CHANNEL_NAME || '💬│blog-chat';
const ROOM_PREFIX = process.env.ROOM_PREFIX || '🔊';

if (!TOKEN) throw new Error('Chưa có DISCORD_TOKEN trong môi trường!');
if (!DATABASE_URL) throw new Error('Chưa có DATABASE_URL (Neon PostgreSQL) trong môi trường!');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Voice Chat Bot (JavaScript) is alive!');
}).listen(PORT, () => {
    console.log(`Web server đã chạy trên cổng ${PORT}`);
});

async function initDb() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS generators (
                guild_id BIGINT PRIMARY KEY,
                category_id BIGINT NOT NULL,
                generator_id BIGINT NOT NULL,
                blog_channel_id BIGINT,
                tracked_text_channel_id BIGINT
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS rooms (
                guild_id BIGINT NOT NULL,
                channel_id BIGINT PRIMARY KEY,
                owner_id BIGINT NOT NULL,
                category_id BIGINT NOT NULL
            )
        `);
        console.log('Đã kết nối và khởi tạo cơ sở dữ liệu Neon thành công!');
    } catch (e) {
        console.error('Lỗi khởi tạo DB:', e);
    }
}

async function getGenerator(guildId) {
    const res = await pool.query('SELECT * FROM generators WHERE guild_id = $1', [guildId]);
    return res.rows[0] || null;
}

async function saveGenerator(guildId, categoryId, generatorId, blogChannelId, trackedTextChannelId = null) {
    await pool.query(`
        INSERT INTO generators(guild_id, category_id, generator_id, blog_channel_id, tracked_text_channel_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (guild_id) DO UPDATE SET
            category_id = EXCLUDED.category_id,
            generator_id = EXCLUDED.generator_id,
            blog_channel_id = COALESCE(EXCLUDED.blog_channel_id, generators.blog_channel_id),
            tracked_text_channel_id = COALESCE(EXCLUDED.tracked_text_channel_id, generators.tracked_text_channel_id)
    `, [guildId, categoryId, generatorId, blogChannelId, trackedTextChannelId]);
}

async function updateTrackedChannel(guildId, channelId) {
    await pool.query('UPDATE generators SET tracked_text_channel_id = $1 WHERE guild_id = $2', [channelId, guildId]);
}

async function clearTrackedChannel(guildId) {
    await pool.query('UPDATE generators SET tracked_text_channel_id = NULL WHERE guild_id = $1', [guildId]);
}

async function saveRoom(guildId, channelId, ownerId, categoryId) {
    await pool.query(`
        INSERT INTO rooms(guild_id, channel_id, owner_id, category_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (channel_id) DO UPDATE SET owner_id = EXCLUDED.owner_id
    `, [guildId, channelId, ownerId, categoryId]);
}

async function getRoom(channelId) {
    const res = await pool.query('SELECT * FROM rooms WHERE channel_id = $1', [channelId]);
    return res.rows[0] || null;
}

async function getOwnedRoom(guildId, ownerId) {
    const res = await pool.query('SELECT * FROM rooms WHERE guild_id = $1 AND owner_id = $2', [guildId, ownerId]);
    return res.rows[0] || null;
}

async function deleteRoomRecord(channelId) {
    await pool.query('DELETE FROM rooms WHERE channel_id = $1', [channelId]);
}

async function sendBlogLog(guild, tag, content) {
    try {
        const gen = await getGenerator(guild.id);
        if (gen && gen.blog_channel_id) {
            const blogCh = guild.channels.cache.get(gen.blog_channel_id.toString());
            if (blogCh) {
                const timestamp = Math.floor(Date.now() / 1000);
                const cleanContent = content.replace(/\n/g, ' ');
                await blogCh.send(`\`[${tag}]\` <t:${timestamp}:t> -${cleanContent}`);
            }
        }
    } catch (e) {
        console.error('Không thể gửi blog log:', e);
    }
}

// Bảng điều khiển màu Xanh Dương (Blurple) chuẩn Discord, gọn gàng, logic
function getControlRows(isOwner) {
    if (isOwner) {
        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('vc_toggle_lock').setLabel('Khóa / Mở').setStyle(ButtonStyle.Primary).setEmoji('🔒'),
            new ButtonBuilder().setCustomId('vc_toggle_hide').setLabel('Ẩn / Hiện').setStyle(ButtonStyle.Primary).setEmoji('🥷'),
            new ButtonBuilder().setCustomId('vc_rename').setLabel('Đổi tên').setStyle(ButtonStyle.Primary).setEmoji('✏️'),
            new ButtonBuilder().setCustomId('vc_limit').setLabel('Giới hạn').setStyle(ButtonStyle.Primary).setEmoji('👥')
        );
        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('vc_allow').setLabel('Cấp quyền').setStyle(ButtonStyle.Primary).setEmoji('✅'),
            new ButtonBuilder().setCustomId('vc_deny').setLabel('Cấm').setStyle(ButtonStyle.Secondary).setEmoji('🚫'),
            new ButtonBuilder().setCustomId('vc_kick').setLabel('Đuổi').setStyle(ButtonStyle.Secondary).setEmoji('👞'),
            new ButtonBuilder().setCustomId('vc_transfer').setLabel('Chuyển chủ').setStyle(ButtonStyle.Success).setEmoji('👑')
        );
        return [row1, row2];
    } else {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('vc_claim').setLabel('Nhận chủ phòng').setStyle(ButtonStyle.Success).setEmoji('👑'),
            new ButtonBuilder().setCustomId('vc_info').setLabel('Thông tin phòng').setStyle(ButtonStyle.Primary).setEmoji('ℹ️')
        );
        return [row];
    }
}

client.once('ready', async () => {
    await initDb();
    client.user.setActivity('Quản lý phòng thoại chuyên nghiệp');
    console.log(`Đăng nhập thành công bot: ${client.user.tag}`);
    await client.application.commands.set([
        {
            name: 'setup',
            description: '[Admin] Khởi tạo hệ thống phòng thoại chọn danh mục trực quan',
            defaultMemberPermissions: PermissionsBitField.Flags.Administrator.toString()
        },
        {
            name: 'track-channel',
            description: '[Admin] Gán kênh chat hiện tại để theo dõi thời gian thực',
            defaultMemberPermissions: PermissionsBitField.Flags.Administrator.toString()
        },
        {
            name: 'untrack-channel',
            description: '[Admin] Hủy theo dõi kênh chat hiện tại',
            defaultMemberPermissions: PermissionsBitField.Flags.Administrator.toString()
        }
    ]);
    console.log('Đã đồng bộ Slash Commands thành công!');
});

// Xử lý sự kiện voiceStateUpdate an toàn tuyệt đối, chống lỗi null property
client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
        const member = newState.member || oldState.member;
        if (!member || member.user.bot) return;
        const guild = member.guild;

        // Thành viên tham gia kênh mới
        if (newState?.channelId && (!oldState?.channelId || oldState.channelId !== newState.channelId)) {
            const gen = await getGenerator(guild.id);
            if (gen && gen.generator_id && newState.channelId === gen.generator_id.toString()) {
                await createRoom(guild, member, newState.channel.parent);
            }
        }

        // Thành viên rời kênh cũ
        if (oldState?.channelId && (!newState?.channelId || oldState.channelId !== newState.channelId)) {
            const gen = await getGenerator(guild.id);
            if (gen && gen.generator_id && oldState.channelId === gen.generator_id.toString()) return;

            const room = await getRoom(oldState.channelId);
            const oldChannel = oldState.channel;
            if (room && oldChannel && oldChannel.members.size === 0) {
                const rId = oldChannel.id;
                const rName = oldChannel.name;
                await deleteRoomRecord(rId);

                try {
                    await oldChannel.delete();
                    await sendBlogLog(guild, 'XÓA PHÒNG', `Phòng trống \`${rName}\` đã bị xóa tự động`);
                } catch (e) {}
            }
        }
    } catch (err) {
        console.error('Lỗi trong voiceStateUpdate:', err);
    }
});

async function createRoom(guild, member, category) {
    const existing = await getOwnedRoom(guild.id, member.id);
    if (existing) {
        const oldCh = guild.channels.cache.get(existing.channel_id.toString());
        if (oldCh && oldCh.isVoiceBased()) {
            try {
                await member.voice.setChannel(oldCh);
                await sendBlogLog(guild, 'TÁI SỬ DỤNG', `${member} vào lại phòng ${oldCh}`);
                return oldCh;
            } catch (e) {}
        }
        await deleteRoomRecord(existing.channel_id);
    }

    const newChannel = await guild.channels.create({
        name: `${ROOM_PREFIX} Phòng của ${member.displayName}`,
        type: 2,
        parent: category ? category.id : null
    });

    await member.voice.setChannel(newChannel);
    await saveRoom(guild.id, newChannel.id, member.id, category ? category.id : 0);
    await sendBlogLog(guild, 'TẠO PHÒNG', `Chủ: ${member} ➔${newChannel}`);

    const embed = new EmbedBuilder()
        .setTitle('🎛️ BẢNG ĐIỀU KHIỂN PHÒNG THOẠI')
        .setDescription(`Chủ phòng hiện tại: ${member}\n\nChào mừng bạn đến với không gian trò chuyện riêng tư và lịch sự. Vui lòng sử dụng các phím điều khiển bên dưới để tùy chỉnh phòng.`)
        .setColor(0x5865F2)
        .setThumbnail(member.user.displayAvatarURL());

    await newChannel.send({
        content: `👋 Chào mừng bạn đến với phòng thoại riêng tư, **${member.displayName}**! Chúc bạn có những phút giây trò chuyện vui vẻ, văn minh và lịch sự.`,
        embeds: [embed],
        components: getControlRows(true)
    });

    return newChannel;
}

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const room = await getRoom(message.channel.id);
    if (room) {
        const contentPreview = message.content || '[Tệp đính kèm]';
        await sendBlogLog(message.guild, 'CHAT PHÒNG', `${message.author} trong ${message.channel}:${contentPreview}`);
    }

    const gen = await getGenerator(message.guild.id);
    if (gen && gen.tracked_text_channel_id && message.channel.id === gen.tracked_text_channel_id.toString()) {
        const contentPreview = message.content || '[Tệp đính kèm]';
        await sendBlogLog(message.guild, 'THEO DÕI CHAT', `${message.author} tại ${message.channel}:${contentPreview}`);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.guild) return;

    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'setup') {
            const categories = interaction.guild.channels.cache.filter(c => c.type === 4);
            if (categories.size === 0) {
                return interaction.reply({ content: '❌ Server chưa có danh mục (Category) nào!', ephemeral: true });
            }
            const options = categories.first(25).map(cat => ({ label: cat.name, value: cat.id, emoji: '📁' }));
            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('setup_category_select')
                    .setPlaceholder('📂 Chọn danh mục (Category) để cài đặt hệ thống...')
                    .addOptions(options)
            );
            await interaction.reply({ content: '📂 **Vui lòng chọn danh mục bên dưới để cấu hình bot:**', components: [row], ephemeral: true });
        } else if (interaction.commandName === 'track-channel') {
            if (!interaction.channel.isTextBased()) {
                return interaction.reply({ content: '❌ Lệnh này chỉ dùng được trong kênh văn bản!', ephemeral: true });
            }
            await updateTrackedChannel(interaction.guild.id, interaction.channel.id);
            await sendBlogLog(interaction.guild, 'GÁN THEO DÕI', `${interaction.user} đã gán kênh ${interaction.channel}`);
            await interaction.reply({ content: `✅ Đã gán kênh ${interaction.channel} vào hệ thống theo dõi thời gian thực!`, ephemeral: true });
        } else if (interaction.commandName === 'untrack-channel') {
            await clearTrackedChannel(interaction.guild.id);
            await sendBlogLog(interaction.guild, 'HỦY THEO DÕI', `${interaction.user} đã hủy theo dõi kênh`);
            await interaction.reply({ content: '✅ Đã hủy theo dõi kênh chat thành công!', ephemeral: true });
        }
        return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'setup_category_select') {
        const catId = interaction.values[0];
        const category = interaction.guild.channels.cache.get(catId);
        if (!category) return interaction.reply({ content: '❌ Danh mục không hợp lệ!', ephemeral: true });

        let generator = category.children.cache.find(c => c.name === DEFAULT_GENERATOR && c.isVoiceBased());
        if (!generator) {
            generator = await interaction.guild.channels.create({ name: DEFAULT_GENERATOR, type: 2, parent: category.id });
        }

        let blogChannel = category.children.cache.find(c => c.name === FIXED_BLOG_NAME && !c.isVoiceBased());
        if (!blogChannel) {
            blogChannel = await interaction.guild.channels.create({ name: FIXED_BLOG_NAME, type: 0, parent: category.id });
        }

        await saveGenerator(interaction.guild.id, category.id, generator.id, blogChannel.id);
        await interaction.update({ content: `✅ **Khởi tạo hệ thống thành công!**\n- Danh mục: **${category.name}**\n- Kênh tạo phòng: ${generator}\n- Kênh Blog Log: ${blogChannel}`, components: [] });
        return;
    }

    if (interaction.isButton()) {
        const channel = interaction.member?.voice?.channel;
        if (!channel) return interaction.reply({ content: '❌ Bạn cần tham gia vào phòng thoại trước khi sử dụng tính năng này.', ephemeral: true });

        const room = await getRoom(channel.id);
        const isOwner = (room && room.owner_id.toString() === interaction.user.id);
        const customId = interaction.customId;

        if (customId === 'vc_claim') {
            if (!room) return interaction.reply({ content: '❌ Đây không phải là phòng thoại tạm!', ephemeral: true });
            const owner = interaction.guild.members.cache.get(room.owner_id.toString());
            if (owner && channel.members.has(owner.id)) {
                return interaction.reply({ content: '❌ Chủ phòng cũ vẫn đang ở trong phòng, chưa thể nhận quyền.', ephemeral: true });
            }
            await saveRoom(interaction.guild.id, channel.id, interaction.user.id, channel.parentId || 0);
            await sendBlogLog(interaction.guild, 'NHẬN CHỦ', `${interaction.user} tiếp quản phòng ${channel}`);
            
            const newEmbed = new EmbedBuilder()
                .setTitle('🎛️ BẢNG ĐIỀU KHIỂN PHÒNG THOẠI')
                .setDescription(`Chủ phòng hiện tại: ${interaction.user}\n\nChào mừng quý khách đến với không gian trò chuyện riêng tư và lịch sự. Vui lòng sử dụng các phím điều khiển bên dưới để tùy chỉnh phòng.`)
                .setColor(0x5865F2)
                .setThumbnail(interaction.user.displayAvatarURL());

            try {
                await interaction.message.edit({ embeds: [newEmbed], components: getControlRows(true) });
                await interaction.reply({ content: `👑 Chúc mừng **${interaction.user.displayName}** đã tiếp quản quyền chủ phòng thành công!`, ephemeral: true });
            } catch (e) {
                await interaction.reply({ content: `👑 **${interaction.user.displayName}** đã tiếp quản quyền chủ phòng thành công!`, ephemeral: true });
            }
            return;
        }

        if (customId === 'vc_info') {
            let ownerName = 'Không xác định';
            if (room) {
                const ownerObj = interaction.guild.members.cache.get(room.owner_id.toString());
                if (ownerObj) ownerName = ownerObj.displayName;
            }
            return interaction.reply({ content: `ℹ️ **Thông tin phòng thoại:**\n- Tên phòng: ${channel.name}\n- Chủ phòng: ${ownerName}\n- Thành viên đang tham gia: ${channel.members.size} người`, ephemeral: true });
        }

        if (!isOwner) {
            return interaction.reply({ content: '❌ Chỉ chủ phòng mới có quyền thực hiện các thao tác quản lý này.', ephemeral: true });
        }

        // Logic Khóa / Mở khóa chuẩn xác
        if (customId === 'vc_toggle_lock') {
            const everyonePerms = channel.permissionsFor(interaction.guild.id);
            const isLocked = everyonePerms && !everyonePerms.has(PermissionsBitField.Flags.Connect);
            
            if (isLocked) {
                await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: null });
                await sendBlogLog(interaction.guild, 'MỞ KHÓA', `${interaction.user} đã mở khóa phòng`);
                await interaction.reply({ content: '🔓 Đã mở khóa phòng thành công. Mọi người có thể tự do vào phòng.', ephemeral: true });
            } else {
                await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: false });
                await channel.permissionOverwrites.edit(interaction.user, { Connect: true });
                await sendBlogLog(interaction.guild, 'KHÓA', `${interaction.user} đã khóa phòng`);
                await interaction.reply({ content: '🔒 Đã khóa phòng thành công. Chỉ những người được cấp quyền mới có thể vào.', ephemeral: true });
            }
        } 
        // Logic Ẩn / Hiện phòng chuẩn xác
        else if (customId === 'vc_toggle_hide') {
            const everyonePerms = channel.permissionsFor(interaction.guild.id);
            const isHidden = everyonePerms && !everyonePerms.has(PermissionsBitField.Flags.ViewChannel);

            if (isHidden) {
                await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: null });
                await sendBlogLog(interaction.guild, 'HIỆN', `${interaction.user} đã hiển thị lại phòng`);
                await interaction.reply({ content: '👁️ Đã hiện phòng thoại thành công.', ephemeral: true });
            } else {
                await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: false });
                await channel.permissionOverwrites.edit(interaction.user, { ViewChannel: true });
                await sendBlogLog(interaction.guild, 'ẨN', `${interaction.user} đã ẩn phòng`);
                await interaction.reply({ content: '🥷 Đã ẩn phòng thoại thành công.', ephemeral: true });
            }
        } 
        else if (customId === 'vc_rename') {
            const modal = new ModalBuilder().setCustomId('modal_rename').setTitle('✏️ Đổi tên phòng thoại');
            const input = new TextInputBuilder()
                .setCustomId('input_rename')
                .setLabel('Tên phòng mới (Ví dụ: Góc tâm sự, Chơi game...)')
                .setPlaceholder('Vui lòng đặt tên văn minh, lịch sự...')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
        } 
        else if (customId === 'vc_limit') {
            const modal = new ModalBuilder().setCustomId('modal_limit').setTitle('⚙️ Giới hạn số lượng thành viên');
            const input = new TextInputBuilder()
                .setCustomId('input_limit')
                .setLabel('Số lượng tối đa (Nhập từ 1 đến 99)')
                .setPlaceholder('Ví dụ: 5')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
        } 
        else if (customId === 'vc_allow') {
            const modal = new ModalBuilder().setCustomId('modal_allow').setTitle('✅ Cấp quyền vào phòng');
            const input = new TextInputBuilder()
                .setCustomId('input_uid')
                .setLabel('ID Discord thành viên (Bật Cài đặt > Nâng cao > Bật Chế độ nhà phát triển, sau đó bấm chuột phải vào tên thành viên > Sao chép ID)')
                .setPlaceholder('Ví dụ: 123456789012345678')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
        } 
        else if (customId === 'vc_deny') {
            const modal = new ModalBuilder().setCustomId('modal_deny').setTitle('🚫 Cấm thành viên');
            const input = new TextInputBuilder()
                .setCustomId('input_uid')
                .setLabel('ID Discord thành viên cần cấm lịch sự')
                .setPlaceholder('Ví dụ: 123456789012345678')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
        } 
        else if (customId === 'vc_kick') {
            const modal = new ModalBuilder().setCustomId('modal_kick').setTitle('👞 Mời thành viên rời phòng');
            const input = new TextInputBuilder()
                .setCustomId('input_uid')
                .setLabel('ID Discord thành viên cần mời ra ngoài')
                .setPlaceholder('Ví dụ: 123456789012345678')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
        } 
        else if (customId === 'vc_transfer') {
            const modal = new ModalBuilder().setCustomId('modal_transfer').setTitle('👑 Chuyển chủ phòng');
            const input = new TextInputBuilder()
                .setCustomId('input_uid')
                .setLabel('ID Discord của người nhận quyền')
                .setPlaceholder('Ví dụ: 123456789012345678')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
        }
        return;
    }

    if (interaction.isModalSubmit()) {
        const channel = interaction.member?.voice?.channel;
        if (!channel) return interaction.reply({ content: '❌ Bạn phải ở trong phòng thoại!', ephemeral: true });

        const room = await getRoom(channel.id);
        if (!room || room.owner_id.toString() !== interaction.user.id) {
            return interaction.reply({ content: '❌ Chỉ chủ phòng mới có quyền thực hiện thao tác này.', ephemeral: true });
        }

        if (interaction.customId === 'modal_rename') {
            const newNameVal = interaction.fields.getTextInputValue('input_rename').trim();
            const oldName = channel.name;
            const newRoomName = `${ROOM_PREFIX}${newNameVal}`;
            await channel.setName(newRoomName);
            await sendBlogLog(interaction.guild, 'ĐỔI TÊN', `${interaction.user} đổi \`${oldName}\` ➔ \`${newRoomName}\``);
            await interaction.reply({ content: `✅ Đã đổi tên phòng thành: **${newNameVal}**. Chúc bạn có những phút giây trò chuyện vui vẻ, văn minh!`, ephemeral: true });
        } else if (interaction.customId === 'modal_limit') {
            const limitVal = parseInt(interaction.fields.getTextInputValue('input_limit'));
            if (isNaN(limitVal) || limitVal < 0 || limitVal > 99) {
                return interaction.reply({ content: '❌ Vui lòng nhập số hợp lệ từ 0 đến 99.', ephemeral: true });
            }
            await channel.setUserLimit(limitVal);
            await sendBlogLog(interaction.guild, 'GIỚI HẠN', `${interaction.user} đặt giới hạn phòng thành ${limitVal}`);
            await interaction.reply({ content: `✅ Đã cập nhật giới hạn phòng thành **${limitVal}** người.`, ephemeral: true });
        } else if (['modal_allow', 'modal_deny', 'modal_kick'].includes(interaction.customId)) {
            const uidStr = interaction.fields.getTextInputValue('input_uid').trim();
            const uid = parseInt(uidStr);
            if (isNaN(uid)) return interaction.reply({ content: '❌ ID Discord không hợp lệ. Vui lòng kiểm tra lại dãy số ID.', ephemeral: true });

            let targetMember;
            try {
                targetMember = await interaction.guild.members.fetch(uid);
            } catch (err) {
                return interaction.reply({ content: '❌ Không tìm thấy thành viên này trong server. Vui lòng kiểm tra lại ID.', ephemeral: true });
            }

            if (interaction.customId === 'modal_allow') {
                await channel.permissionOverwrites.edit(targetMember, { Connect: true, ViewChannel: true });
                await sendBlogLog(interaction.guild, 'CẤP QUYỀN', `${interaction.user} cấp quyền cho ${targetMember}`);
                await interaction.reply({ content: `✅ Đã cấp quyền vào phòng thành công cho **${targetMember.displayName}**.`, ephemeral: true });
            } else if (interaction.customId === 'modal_deny') {
                await channel.permissionOverwrites.edit(targetMember, { Connect: false });
                if (targetMember.voice && targetMember.voice.channelId === channel.id) {
                    await targetMember.voice.disconnect();
                }
                await sendBlogLog(interaction.guild, 'CẤM', `${interaction.user} cấm ${targetMember}`);
                await interaction.reply({ content: `🚫 Đã cấm thành viên **${targetMember.displayName}** khỏi phòng lịch sự.`, ephemeral: true });
            } else if (interaction.customId === 'modal_kick') {
                if (targetMember.voice && targetMember.voice.channelId === channel.id) {
                    await targetMember.voice.disconnect();
                    await sendBlogLog(interaction.guild, 'ĐUỔI', `${interaction.user} đá ${targetMember} ra khỏi phòng`);
                    await interaction.reply({ content: `👞 Đã mời thành viên **${targetMember.displayName}** rời khỏi phòng nhẹ nhàng.`, ephemeral: true });
                } else {
                    await interaction.reply({ content: '❌ Thành viên này hiện không có trong phòng của bạn.', ephemeral: true });
                }
            }
        } else if (interaction.customId === 'modal_transfer') {
            const uidStr = interaction.fields.getTextInputValue('input_uid').trim();
            const uid = parseInt(uidStr);
            if (isNaN(uid)) return interaction.reply({ content: '❌ ID Discord không hợp lệ.', ephemeral: true });

            const targetMember = await interaction.guild.members.fetch(uid).catch(() => null);
            if (!targetMember || targetMember.voice.channelId !== channel.id) {
                return interaction.reply({ content: '❌ Người nhận quyền phải đang có mặt trực tiếp trong phòng thoại với bạn.', ephemeral: true });
            }

            await saveRoom(interaction.guild.id, channel.id, targetMember.id, channel.parentId || 0);
            await sendBlogLog(interaction.guild, 'CHUYỂN CHỦ', `Phòng ${channel} chuyển quyền cho ${targetMember}`);
            
            const newEmbed = new EmbedBuilder()
                .setTitle('🎛️ BẢNG ĐIỀU KHIỂN PHÒNG THOẠI')
                .setDescription(`Chủ phòng hiện tại: ${targetMember}\n\nChào mừng quý khách đến với không gian trò chuyện riêng tư và lịch sự. Vui lòng sử dụng các phím điều khiển bên dưới để tùy chỉnh phòng.`)
                .setColor(0x5865F2)
                .setThumbnail(targetMember.user.displayAvatarURL());

            try {
                await interaction.message.edit({ embeds: [newEmbed], components: getControlRows(true) });
            } catch (e) {}

            await interaction.reply({ content: `👑 Đã chuyển quyền chủ phòng thành công cho **${targetMember.displayName}**!`, ephemeral: true });
        }
    }
});

client.login(TOKEN);
