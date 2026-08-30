use risuai_assets::bulk_protocol::{
    create_chunk_packet, create_end_packet, create_header_packet, BulkPacket, BulkPacketParser,
};

#[test]
fn test_bulk_packet_roundtrip() {
    let mut parser = BulkPacketParser::new();

    let header_bytes = create_header_packet(42, "images/avatar.png", 100);
    let chunk1_bytes = create_chunk_packet(42, b"hello ");
    let chunk2_bytes = create_chunk_packet(42, b"world!");
    let end_bytes = create_end_packet(42);

    let mut stream = Vec::new();
    stream.extend_from_slice(&header_bytes);
    stream.extend_from_slice(&chunk1_bytes);
    stream.extend_from_slice(&chunk2_bytes);
    stream.extend_from_slice(&end_bytes);

    parser.push(&stream);

    // Packet 1: Header
    let p1 = parser.next_packet().unwrap().unwrap();
    match p1 {
        BulkPacket::Header {
            file_id,
            name,
            total_size,
        } => {
            assert_eq!(file_id, 42);
            assert_eq!(name, "images/avatar.png");
            assert_eq!(total_size, 100);
        }
        _ => panic!("Expected Header packet"),
    }

    // Packet 2: Chunk 1
    let p2 = parser.next_packet().unwrap().unwrap();
    match p2 {
        BulkPacket::Chunk { file_id, data } => {
            assert_eq!(file_id, 42);
            assert_eq!(&data[..], b"hello ");
        }
        _ => panic!("Expected Chunk packet"),
    }

    // Packet 3: Chunk 2
    let p3 = parser.next_packet().unwrap().unwrap();
    match p3 {
        BulkPacket::Chunk { file_id, data } => {
            assert_eq!(file_id, 42);
            assert_eq!(&data[..], b"world!");
        }
        _ => panic!("Expected Chunk packet"),
    }

    // Packet 4: End
    let p4 = parser.next_packet().unwrap().unwrap();
    match p4 {
        BulkPacket::End { file_id } => {
            assert_eq!(file_id, 42);
        }
        _ => panic!("Expected End packet"),
    }

    // No more packets
    assert!(parser.next_packet().unwrap().is_none());
}
